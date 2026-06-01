import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { AppRuntime } from "../../src/effect/app-runtime"
import { FileWatcher } from "../../src/file/watcher"
import { Instance } from "../../src/project/instance"
import { GlobalBus } from "../../src/bus/global"
import { Vcs } from "../../src/project/vcs"
import { testEffect } from "../lib/effect"
import { shouldRunNativeWatcherTests } from "../file/native-watcher-ci-guard"

// Skip in CI — native @parcel/watcher binding needed
const describeVcs = shouldRunNativeWatcherTests(FileWatcher.hasNativeBinding) ? describe : describe.skip

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withVcs(directory: string, body: () => Promise<void>) {
  return Instance.provide({
    directory,
    fn: async () => {
      void AppRuntime.runPromise(FileWatcher.Service.use((svc) => svc.init()))
      Vcs.init()
      await Bun.sleep(500)
      await body()
    },
  })
}

function withVcsOnly(directory: string, body: () => Promise<void>) {
  return provideInstance(directory)(
    Effect.gen(function* () {
      const vcs = yield* Vcs.Service
      yield* vcs.init()
      yield* Effect.promise(body)
    }),
  )
}

type BranchEvent = { directory?: string; payload: { type: string; properties: { branch?: string } } }
const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"
const vcsIt = testEffect(Vcs.defaultLayer)

type TmpdirOptions = Parameters<typeof tmpdir>[0]
const scopedTmpdir = (options?: TmpdirOptions) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

/** Wait for a Vcs.Event.BranchUpdated event on GlobalBus, with retry polling as fallback */
function nextBranchUpdate(directory: string, timeout = 10_000) {
  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      GlobalBus.off("event", on)
      reject(new Error("timed out waiting for BranchUpdated event"))
    }, timeout)

    function on(evt: BranchEvent) {
      if (evt.directory !== directory) return
      if (evt.payload.type !== Vcs.Event.BranchUpdated.type) return
      if (settled) return
      settled = true
      clearTimeout(timer)
      GlobalBus.off("event", on)
      resolve(evt.payload.properties.branch)
    }

    GlobalBus.on("event", on)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeVcs("Vcs", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("branch() returns current branch name", async () => {
    await using tmp = await tmpdir({ git: true })

    await withVcs(tmp.path, async () => {
      const branch = await Vcs.branch()
      expect(branch).toBeDefined()
      expect(typeof branch).toBe("string")
    })
  })

  test("branch() returns undefined for non-git directories", async () => {
    await using tmp = await tmpdir()

    await withVcs(tmp.path, async () => {
      const branch = await Vcs.branch()
      expect(branch).toBeUndefined()
    })
  })

  test("publishes BranchUpdated when .git/HEAD changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const branch = `test-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withVcs(tmp.path, async () => {
      const pending = nextBranchUpdate(tmp.path)

      const head = path.join(tmp.path, ".git", "HEAD")
      await fs.writeFile(head, `ref: refs/heads/${branch}\n`)

      const updated = await pending
      expect(updated).toBe(branch)
    })
  })

  test("branch() reflects the new branch after HEAD change", async () => {
    await using tmp = await tmpdir({ git: true })
    const branch = `test-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withVcs(tmp.path, async () => {
      const pending = nextBranchUpdate(tmp.path)

      const head = path.join(tmp.path, ".git", "HEAD")
      await fs.writeFile(head, `ref: refs/heads/${branch}\n`)

      await pending
      const current = await Vcs.branch()
      expect(current).toBe(branch)
    })
  })
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  vcsIt.live("status() returns tracked, staged, and untracked file summaries", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
        await $`git add tracked.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")
        await fs.writeFile(path.join(tmp.path, "staged.txt"), "staged\n", "utf-8")
        await $`git add staged.txt`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "untracked.txt"), "untracked\n", "utf-8")
      })

      yield* withVcsOnly(tmp.path, async () => {
        const status = await Vcs.status()
        expect(status).toEqual([
          { file: "staged.txt", additions: 1, deletions: 0, status: "added" },
          { file: "tracked.txt", additions: 1, deletions: 1, status: "modified" },
          { file: "untracked.txt", additions: 1, deletions: 0, status: "added" },
        ])
      })
    }),
  )

  vcsIt.live("defaultBranch() falls back to main", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await $`git branch -M main`.cwd(tmp.path).quiet()
      })

      yield* withVcsOnly(tmp.path, async () => {
        const branch = await Vcs.defaultBranch()
        expect(branch).toBe("main")
      })
    }),
  )

  vcsIt.live("defaultBranch() uses init.defaultBranch when available", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await $`git branch -M trunk`.cwd(tmp.path).quiet()
        await $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet()
      })

      yield* withVcsOnly(tmp.path, async () => {
        const branch = await Vcs.defaultBranch()
        expect(branch).toBe("trunk")
      })
    }),
  )

  vcsIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const wt = yield* scopedTmpdir()
      const dir = path.join(wt.path, "feature")
      yield* Effect.promise(async () => {
        await $`git branch -M main`.cwd(tmp.path).quiet()
        await $`git worktree add -b feature/test ${dir} HEAD`.cwd(tmp.path).quiet()
      })

      yield* withVcsOnly(dir, async () => {
        const [branch, base] = await Promise.all([Vcs.branch(), Vcs.defaultBranch()])
        expect(branch).toBe("feature/test")
        expect(base).toBe("main")
      })
    }),
  )

  vcsIt.live("diff('git') merges staged, unstaged, and untracked changes into one view", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
        await $`git add tracked.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")
        await fs.writeFile(path.join(tmp.path, "staged.txt"), "staged\n", "utf-8")
        await $`git add staged.txt`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "untracked.txt"), "untracked\n", "utf-8")
      })

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("git")
        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ file: "tracked.txt", status: "modified" }),
            expect.objectContaining({ file: "staged.txt", status: "added" }),
            expect.objectContaining({ file: "untracked.txt", status: "added" }),
          ]),
        )
        expect(diff.find((item) => item.file === "tracked.txt")?.patch).toContain("diff --git")
        expect(diff.find((item) => item.file === "staged.txt")?.patch).toContain("+staged")
        expect(diff.find((item) => item.file === "untracked.txt")?.patch).toContain("+untracked")
      })
    }),
  )

  vcsIt.live("diff('git') still surfaces staged content when the worktree happens to match HEAD", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "v1\n", "utf-8")
        await $`git add tracked.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "v1"`.cwd(tmp.path).quiet()
        // Stage a v2, then write the worktree back to v1 without resetting the index.
        // Status reads "MM" but the worktree byte-for-byte matches HEAD, so the plain
        // `git diff HEAD` form sees nothing. The staged contents will still land in the
        // next commit, so the review panel must surface them.
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "v2\n", "utf-8")
        await $`git add tracked.txt`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "v1\n", "utf-8")
      })

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("git")
        const entry = diff.find((item) => item.file === "tracked.txt")
        expect(entry).toBeDefined()
        expect(entry?.patch).toContain("+v2")
        expect(entry?.additions).toBeGreaterThan(0)
      })
    }),
  )

  vcsIt.live("diffRaw() returns a patch with tracked and untracked changes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
        await $`git add tracked.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")
        await fs.writeFile(path.join(tmp.path, "untracked.txt"), "new\n", "utf-8")
      })

      yield* withVcsOnly(tmp.path, async () => {
        const patch = await Vcs.diffRaw()
        expect(patch).toContain("diff --git a/tracked.txt b/tracked.txt")
        expect(patch).toContain("-original")
        expect(patch).toContain("+changed")
        expect(patch).toContain("diff --git a/untracked.txt b/untracked.txt")
        expect(patch).toContain("+new")
      })
    }),
  )

  vcsIt.live("apply() applies a valid patch", () =>
    Effect.gen(function* () {
      const source = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(source.path, "tracked.txt"), "original\n", "utf-8")
        await $`git add tracked.txt`.cwd(source.path).quiet()
        await $`git commit --no-gpg-sign -m "add file"`.cwd(source.path).quiet()
        await fs.writeFile(path.join(source.path, "tracked.txt"), "changed\n", "utf-8")
      })

      let patch = ""
      yield* withVcsOnly(source.path, async () => {
        patch = await Vcs.diffRaw()
      })

      const target = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(target.path, "tracked.txt"), "original\n", "utf-8")
        await $`git add tracked.txt`.cwd(target.path).quiet()
        await $`git commit --no-gpg-sign -m "add file"`.cwd(target.path).quiet()
      })

      yield* withVcsOnly(target.path, async () => {
        await expect(Vcs.apply({ patch })).resolves.toEqual({ applied: true })
        await expect(fs.readFile(path.join(target.path, "tracked.txt"), "utf-8")).resolves.toBe("changed\n")
      })
    }),
  )

  vcsIt.live("apply() rejects non-git directories", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()

      yield* withVcsOnly(tmp.path, async () => {
        await expect(Vcs.apply({ patch: "diff --git a/file.txt b/file.txt\n" })).rejects.toMatchObject({
          reason: "non-git",
        })
      })
    }),
  )

  vcsIt.live("apply() rejects patches that do not apply cleanly", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(tmp.path, "tracked.txt"), "different\n", "utf-8")
        await $`git add tracked.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
      })

      const patch = [
        "diff --git a/tracked.txt b/tracked.txt",
        "index 5626abf..21fb1ec 100644",
        "--- a/tracked.txt",
        "+++ b/tracked.txt",
        "@@ -1 +1 @@",
        "-original",
        "+changed",
        "",
      ].join("\n")

      yield* withVcsOnly(tmp.path, async () => {
        await expect(Vcs.apply({ patch })).rejects.toMatchObject({
          reason: "not-clean",
        })
        await expect(fs.readFile(path.join(tmp.path, "tracked.txt"), "utf-8")).resolves.toBe("different\n")
      })
    }),
  )

  vcsIt.live("diff('git') handles special filenames", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "hello\n", "utf-8"))

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("git")
        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      })
    }),
  )

  vcsIt.live("diff('git') returns staged files before the first commit", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      yield* Effect.promise(async () => {
        await $`git init`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "first.txt"), "first\n", "utf-8")
        await $`git add first.txt`.cwd(tmp.path).quiet()
      })

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("git")
        expect(diff).toEqual(expect.arrayContaining([expect.objectContaining({ file: "first.txt", status: "added" })]))
      })
    }),
  )

  vcsIt.live("diff('branch') includes committed, staged, unstaged, and untracked branch work", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await $`git branch -M main`.cwd(tmp.path).quiet()
        await $`git checkout -b feature/test`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "branch.txt"), "branch\n", "utf-8")
        await $`git add branch.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "branch file"`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "staged.txt"), "staged\n", "utf-8")
        await $`git add staged.txt`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "unstaged.txt"), "unstaged\n", "utf-8")
        await $`git add unstaged.txt`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "unstaged.txt"), "unstaged-edited\n", "utf-8")
        await fs.writeFile(path.join(tmp.path, "untracked.txt"), "untracked\n", "utf-8")
      })

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("branch")
        // Branch view must reflect the full delta the user sees against the default branch,
        // not just commits — this guards against the regression where `git diff <ref> HEAD`
        // silently dropped staged and working-tree changes.
        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ file: "branch.txt", status: "added" }),
            expect.objectContaining({ file: "staged.txt", status: "added" }),
            expect.objectContaining({ file: "unstaged.txt", status: "added" }),
            expect.objectContaining({ file: "untracked.txt", status: "added" }),
          ]),
        )
      })
    }),
  )

  vcsIt.live("diff('branch') returns changes against default branch", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await $`git branch -M main`.cwd(tmp.path).quiet()
        await $`git checkout -b feature/test`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "branch.txt"), "hello\n", "utf-8")
        await $`git add .`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "branch file"`.cwd(tmp.path).quiet()
      })

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("branch")
        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      })
    }),
  )

  vcsIt.live("diff('branch') reports working-tree edits on top of branch commits", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(tmp.path, "base.txt"), "base\n", "utf-8")
        await $`git add base.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "base"`.cwd(tmp.path).quiet()
        await $`git branch -M main`.cwd(tmp.path).quiet()
        await $`git checkout -b feature/test`.cwd(tmp.path).quiet()
        await fs.writeFile(path.join(tmp.path, "branch.txt"), "branch\n", "utf-8")
        await $`git add branch.txt`.cwd(tmp.path).quiet()
        await $`git commit --no-gpg-sign -m "branch file"`.cwd(tmp.path).quiet()
        // Working-tree edit that has not been committed yet — regression guard
        // for the old `git diff <ref> HEAD` form that swallowed this delta.
        await fs.writeFile(path.join(tmp.path, "branch.txt"), "branch\ndirty\n", "utf-8")
      })

      yield* withVcsOnly(tmp.path, async () => {
        const diff = await Vcs.diff("branch")
        const branch = diff.find((item) => item.file === "branch.txt")
        expect(branch?.patch).toContain("+dirty")
        expect(branch?.additions).toBeGreaterThan(0)
      })
    }),
  )
})
