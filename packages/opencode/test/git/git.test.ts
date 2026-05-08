import { $ } from "bun"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Git } from "../../src/git"
import { tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"
const it = testEffect(Layer.mergeAll(Git.defaultLayer, CrossSpawnSpawner.defaultLayer))

async function withGit<T>(body: (rt: ManagedRuntime.ManagedRuntime<Git.Service, never>) => Promise<T>) {
  const rt = ManagedRuntime.make(Git.defaultLayer)
  try {
    return await body(rt)
  } finally {
    await rt.dispose()
  }
}

describe("Git", () => {
  test("branch() returns current branch name", async () => {
    await using tmp = await tmpdir({ git: true })

    await withGit(async (rt) => {
      const branch = await rt.runPromise(Git.Service.use((git) => git.branch(tmp.path)))
      expect(branch).toBeDefined()
      expect(typeof branch).toBe("string")
    })
  })

  test("branch() returns undefined for non-git directories", async () => {
    await using tmp = await tmpdir()

    await withGit(async (rt) => {
      const branch = await rt.runPromise(Git.Service.use((git) => git.branch(tmp.path)))
      expect(branch).toBeUndefined()
    })
  })

  test("branch() returns undefined for detached HEAD", async () => {
    await using tmp = await tmpdir({ git: true })
    const hash = (await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()).trim()
    await $`git checkout --detach ${hash}`.cwd(tmp.path).quiet()

    await withGit(async (rt) => {
      const branch = await rt.runPromise(Git.Service.use((git) => git.branch(tmp.path)))
      expect(branch).toBeUndefined()
    })
  })

  test("defaultBranch() uses init.defaultBranch when available", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M trunk`.cwd(tmp.path).quiet()
    await $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet()

    await withGit(async (rt) => {
      const branch = await rt.runPromise(Git.Service.use((git) => git.defaultBranch(tmp.path)))
      expect(branch?.name).toBe("trunk")
      expect(branch?.ref).toBe("trunk")
    })
  })

  test("status() handles special filenames", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, weird), "hello\n", "utf-8")

    await withGit(async (rt) => {
      const status = await rt.runPromise(Git.Service.use((git) => git.status(tmp.path)))
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "added",
          }),
        ]),
      )
    })
  })

  test("diff(), stats(), and mergeBase() parse tracked changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await $`git checkout -b feature/test`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8")

    await withGit(async (rt) => {
      const [base, diff, stats] = await Promise.all([
        rt.runPromise(Git.Service.use((git) => git.mergeBase(tmp.path, "main"))),
        rt.runPromise(Git.Service.use((git) => git.diff(tmp.path, "HEAD"))),
        rt.runPromise(Git.Service.use((git) => git.stats(tmp.path, "HEAD"))),
      ])

      expect(base).toBeTruthy()
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "modified",
          }),
        ]),
      )
      expect(stats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            additions: 1,
            deletions: 1,
          }),
        ]),
      )
    })
  })

  it.live("statusUnstaged() excludes staged-only changes and includes untracked files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "tracked.txt"), "base\n", "utf-8"))
      yield* Effect.promise(() => $`git add tracked.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "base"`.cwd(tmp).quiet())

      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "staged.txt"), "staged\n", "utf-8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "unstaged.txt"), "unstaged\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "tracked.txt"), "base\nunstaged\n", "utf-8"))

      const git = yield* Git.Service
      const status = yield* git.statusUnstaged(tmp)
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: "tracked.txt", status: "modified" }),
          expect.objectContaining({ file: "unstaged.txt", status: "added" }),
        ]),
      )
      expect(status).not.toEqual(expect.arrayContaining([expect.objectContaining({ file: "staged.txt" })]))
    }),
  )

  it.live("showIndex() reads staged content instead of working tree content", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "file.txt"), "base\n", "utf-8"))
      yield* Effect.promise(() => $`git add file.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "base"`.cwd(tmp).quiet())

      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "file.txt"), "staged\n", "utf-8"))
      yield* Effect.promise(() => $`git add file.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "file.txt"), "working\n", "utf-8"))

      const git = yield* Git.Service
      const text = yield* git.showIndex(tmp, "file.txt")
      expect(text).toBe("staged\n")
    }),
  )

  it.live("diffUnstaged(), statsUnstaged(), diffStaged(), and statsStaged() split index from working tree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "tracked.txt"), "base\n", "utf-8"))
      yield* Effect.promise(() => $`git add tracked.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "base"`.cwd(tmp).quiet())

      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "staged.txt"), "staged\n", "utf-8"))
      yield* Effect.promise(() => $`git add staged.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "unstaged.txt"), "unstaged\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "tracked.txt"), "base\nstaged\n", "utf-8"))
      yield* Effect.promise(() => $`git add tracked.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "tracked.txt"), "base\nstaged\nworking\n", "utf-8"))

      const git = yield* Git.Service
      const [unstagedDiff, unstagedStats, stagedDiff, stagedStats] = yield* Effect.all([
        git.diffUnstaged(tmp),
        git.statsUnstaged(tmp),
        git.diffStaged(tmp),
        git.statsStaged(tmp),
      ])

      expect(unstagedDiff).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "tracked.txt", status: "modified" })]),
      )
      expect(unstagedDiff).not.toEqual(expect.arrayContaining([expect.objectContaining({ file: "staged.txt" })]))
      expect(unstagedStats).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "tracked.txt", additions: 1, deletions: 0 })]),
      )

      expect(stagedDiff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: "staged.txt", status: "added" }),
          expect.objectContaining({ file: "tracked.txt", status: "modified" }),
        ]),
      )
      expect(stagedDiff).not.toEqual(expect.arrayContaining([expect.objectContaining({ file: "unstaged.txt" })]))
      expect(stagedStats).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "staged.txt", additions: 1, deletions: 0 })]),
      )
    }),
  )

  it.live("diffHead() and statsHead() compare a ref to HEAD without working tree changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => $`git branch -M main`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git checkout -b feature/test`.cwd(tmp).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "branch.txt"), "branch\n", "utf-8"))
      yield* Effect.promise(() => $`git add branch.txt`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "branch file"`.cwd(tmp).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "branch.txt"), "branch\ndirty\n", "utf-8"))

      const git = yield* Git.Service
      const [diff, stats] = yield* Effect.all([git.diffHead(tmp, "main"), git.statsHead(tmp, "main")])

      expect(diff).toEqual(expect.arrayContaining([expect.objectContaining({ file: "branch.txt", status: "added" })]))
      expect(stats).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: "branch.txt", additions: 1, deletions: 0 })]),
      )
    }),
  )

  test("patch helpers return capped native patch output", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8")
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8")

    await withGit(async (rt) => {
      const [patch, capped] = await Promise.all([
        rt.runPromise(Git.Service.use((git) => git.patch(tmp.path, "HEAD", weird, { context: 2_147_483_647 }))),
        rt.runPromise(Git.Service.use((git) => git.patch(tmp.path, "HEAD", weird, { maxOutputBytes: 1 }))),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("-before")
      expect(patch.text).toContain("+after")
      expect(capped.truncated).toBe(true)
      expect(capped.text).toBe("")
    })
  })

  test("run keeps stderr truncation separate from stdout truncation", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })

    await withGit(async (rt) => {
      const result = await rt.runPromise(
        Git.Service.use((git) =>
          git.run(
            [
              "-c",
              "alias.noisy=!f() { printf ok; i=0; while [ $i -lt 2048 ]; do printf x >&2; i=$((i+1)); done; }; f",
              "noisy",
            ],
            { cwd: tmp.path, maxOutputBytes: 16 },
          ),
        ),
      )

      expect(result.text()).toBe("ok")
      expect(result.truncated).toBe(false)
      expect(result.stdoutTruncated).toBe(false)
      expect(result.stderrTruncated).toBe(true)
    })
  })

  test("patchUntracked() and statUntracked() handle added files", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, weird), "one\ntwo\n", "utf-8")

    await withGit(async (rt) => {
      const [patch, stat] = await Promise.all([
        rt.runPromise(Git.Service.use((git) => git.patchUntracked(tmp.path, weird, { context: 2_147_483_647 }))),
        rt.runPromise(Git.Service.use((git) => git.statUntracked(tmp.path, weird))),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("+one")
      expect(patch.text).toContain("+two")
      expect(stat).toEqual(expect.objectContaining({ file: weird, additions: 2, deletions: 0 }))
    })
  })

  test("show() returns empty text for binary blobs", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "bin.dat"), new Uint8Array([0, 1, 2, 3]))
    await $`git add .`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add binary"`.cwd(tmp.path).quiet()

    await withGit(async (rt) => {
      const text = await rt.runPromise(Git.Service.use((git) => git.show(tmp.path, "HEAD", "bin.dat")))
      expect(text).toBe("")
    })
  })
})
