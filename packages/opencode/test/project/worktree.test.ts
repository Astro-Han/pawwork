import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"

const wintest = process.platform !== "win32" ? test : test.skip
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { ProjectTable } from "../../src/project/project.sql"
import { Database, eq } from "../../src/storage/db"
import { Worktree } from "../../src/worktree"
import { tmpdir } from "../fixture/fixture"

function withInstance(directory: string, fn: () => Promise<any>) {
  return Instance.provide({ directory, fn })
}

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

async function waitReady(root: string) {
  const { GlobalBus } = await import("../../src/bus/global")
  const expectedRoot = normalize(root.endsWith(path.sep) ? root : `${root}${path.sep}`)

  return await new Promise<{ name: string; branch: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      GlobalBus.off("event", on)
      reject(new Error("timed out waiting for worktree.ready"))
    }, 10_000)

    function on(evt: { directory?: string; payload: { type: string; properties: { name: string; branch: string } } }) {
      if (evt.payload.type !== Worktree.Event.Ready.type) return
      if (!evt.directory || !normalize(evt.directory).startsWith(expectedRoot)) return
      clearTimeout(timer)
      GlobalBus.off("event", on)
      resolve(evt.payload.properties)
    }

    GlobalBus.on("event", on)
  })
}

describe("Worktree", () => {
  afterEach(() => Instance.disposeAll())

  describe("makeWorktreeInfo", () => {
    test("returns info with name, branch, and directory", async () => {
      await using tmp = await tmpdir({ git: true })

      const info = await withInstance(tmp.path, () => Worktree.makeWorktreeInfo())

      expect(info.name).toBeDefined()
      expect(typeof info.name).toBe("string")
      expect(info.branch).toBe(`pawwork/${info.name}`)
      expect(info.directory).toBe(path.join(tmp.path, ".worktrees", "pawwork", info.name))
      expect(info.source).toBe("created")
    })

    test("uses provided name as base", async () => {
      await using tmp = await tmpdir({ git: true })

      const info = await withInstance(tmp.path, () => Worktree.makeWorktreeInfo("my-feature"))

      expect(info.name).toBe("my-feature")
      expect(info.branch).toBe("pawwork/my-feature")
      expect(info.directory).toBe(path.join(tmp.path, ".worktrees", "pawwork", "my-feature"))
      expect(info.source).toBe("created")
    })

    test("slugifies the provided name", async () => {
      await using tmp = await tmpdir({ git: true })

      const info = await withInstance(tmp.path, () => Worktree.makeWorktreeInfo("My Feature Branch!"))

      expect(info.name).toBe("my-feature-branch")
    })

    test("throws NotGitError for non-git directories", async () => {
      await using tmp = await tmpdir()

      await expect(withInstance(tmp.path, () => Worktree.makeWorktreeInfo())).rejects.toThrow("WorktreeNotGitError")
    })
  })

  describe("create + remove lifecycle", () => {
    test("create returns worktree info and remove cleans up", async () => {
      await using tmp = await tmpdir({ git: true })

      const info = await withInstance(tmp.path, () => Worktree.create())

      expect(info.name).toBeDefined()
      expect(info.branch).toStartWith("pawwork/")
      expect(info.directory).toBeDefined()
      expect(info.source).toBe("created")

      // Wait for bootstrap to complete
      await Bun.sleep(1000)

      const ok = await withInstance(tmp.path, () => Worktree.remove({ directory: info.directory }))
      expect(ok).toBe(true)
    })

    test("create returns after setup and fires Event.Ready after bootstrap", async () => {
      await using tmp = await tmpdir({ git: true })
      const ready = waitReady(path.join(tmp.path, ".worktrees", "pawwork"))

      const info = await withInstance(tmp.path, () => Worktree.create())

      // create returns before bootstrap completes, but the worktree already exists
      expect(info.name).toBeDefined()
      expect(info.branch).toStartWith("pawwork/")
      expect(info.directory).toBe(path.join(tmp.path, ".worktrees", "pawwork", info.name))
      expect(info.source).toBe("created")

      const text = await $`git worktree list --porcelain`.cwd(tmp.path).quiet().text()
      const dir = await fs.realpath(info.directory).catch(() => info.directory)
      expect(normalize(text)).toContain(normalize(dir))

      // Event.Ready fires after bootstrap finishes in the background
      const props = await ready
      expect(props.name).toBe(info.name)
      expect(props.branch).toBe(info.branch)

      // Cleanup
      await withInstance(info.directory, () => Instance.dispose())
      await Bun.sleep(100)
      await withInstance(tmp.path, () => Worktree.remove({ directory: info.directory }))
    })

    test("create with custom name", async () => {
      await using tmp = await tmpdir({ git: true })
      const ready = waitReady(path.join(tmp.path, ".worktrees", "pawwork"))

      const info = await withInstance(tmp.path, () => Worktree.create({ name: "test-workspace" }))

      expect(info.name).toBe("test-workspace")
      expect(info.branch).toBe("pawwork/test-workspace")
      expect(info.directory).toBe(path.join(tmp.path, ".worktrees", "pawwork", "test-workspace"))
      expect(info.source).toBe("created")

      // Cleanup
      await ready
      await withInstance(info.directory, () => Instance.dispose())
      await Bun.sleep(100)
      await withInstance(tmp.path, () => Worktree.remove({ directory: info.directory }))
    })

    test("refuses to create when .gitignore has local changes", async () => {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(path.join(tmp.path, ".gitignore"), "node_modules\n")
      await $`git add .gitignore && git commit -m initial-gitignore`.cwd(tmp.path).quiet()
      await Bun.write(path.join(tmp.path, ".gitignore"), "node_modules\ndist\n")

      await expect(withInstance(tmp.path, () => Worktree.create({ name: "blocked" }))).rejects.toThrow(
        "WorktreeGitignoreGuardError",
      )

      const list = await $`git worktree list --porcelain`.cwd(tmp.path).quiet().text()
      expect(list).not.toContain("pawwork/blocked")
    })

    test("restores .gitignore when git worktree add fails", async () => {
      await using tmp = await tmpdir({ git: true })
      const info = await withInstance(tmp.path, () => Worktree.makeWorktreeInfo("bad-branch"))

      await expect(
        withInstance(tmp.path, () =>
          Worktree.createFromInfo({
            ...info,
            branch: "bad branch name",
          }),
        ),
      ).rejects.toThrow("WorktreeCreateFailedError")

      await expect(Bun.file(path.join(tmp.path, ".gitignore")).text()).rejects.toThrow()
    })
  })

  describe("createFromInfo", () => {
    wintest("creates and bootstraps git worktree", async () => {
      await using tmp = await tmpdir({ git: true })

      const info = await withInstance(tmp.path, () => Worktree.makeWorktreeInfo("from-info-test"))
      await withInstance(tmp.path, () => Worktree.createFromInfo(info))

      // Worktree should exist in git (normalize slashes for Windows)
      const list = await $`git worktree list --porcelain`.cwd(tmp.path).quiet().text()
      const normalizedList = list.replace(/\\/g, "/")
      const normalizedDir = info.directory.replace(/\\/g, "/")
      expect(normalizedList).toContain(normalizedDir)

      // Cleanup
      await withInstance(tmp.path, () => Worktree.remove({ directory: info.directory }))
    })
  })

  describe("registry source", () => {
    test("created worktrees are slug-addressable, existing worktrees are path-addressable only", async () => {
      await using tmp = await tmpdir({ git: true })
      const ready = waitReady(path.join(tmp.path, ".worktrees", "pawwork"))
      const created = await withInstance(tmp.path, () => Worktree.create({ name: "feature-a" }))
      await ready

      const bySlug = await withInstance(tmp.path, () => Worktree.lookupBySlug("feature-a"))
      expect(bySlug?.directory).toBe(created.directory)
      expect(bySlug?.source).toBe("created")

      const byRawName = await withInstance(tmp.path, () => Worktree.lookupBySlug("Feature A"))
      expect(byRawName?.directory).toBe(created.directory)

      const external = path.join(tmp.path, "..", path.basename(tmp.path) + "-external")
      await $`git worktree add ${external} -b external-${Date.now()}`.cwd(tmp.path).quiet()

      const registered = await withInstance(tmp.path, () => Worktree.registerExistingByPath(external))
      expect(registered.source).toBe("existing")
      expect(registered.name).toBe(path.basename(external))

      const byDirectory = await withInstance(tmp.path, () => Worktree.lookupByDirectory(external))
      expect(byDirectory?.source).toBe("existing")

      const notBySlug = await withInstance(tmp.path, () => Worktree.lookupBySlug(path.basename(external)))
      expect(notBySlug).toBeUndefined()

      await withInstance(tmp.path, () => Worktree.remove({ directory: created.directory }))
      await withInstance(tmp.path, () => Worktree.remove({ directory: external }))
    })

    test("legacy string registry entries remain slug-addressable", async () => {
      await using tmp = await tmpdir({ git: true })
      const legacy = path.join(tmp.path, "..", path.basename(tmp.path) + "-legacy")
      await $`git worktree add ${legacy} -b legacy-${Date.now()}`.cwd(tmp.path).quiet()

      await withInstance(tmp.path, async () => {
        Database.use((db) =>
          db
            .update(ProjectTable)
            .set({ sandboxes: [legacy] })
            .where(eq(ProjectTable.id, Instance.project.id))
            .run(),
        )

        const bySlug = await Worktree.lookupBySlug(path.basename(legacy))
        expect(bySlug?.directory).toBe(legacy)
        expect(bySlug?.source).toBe("created")

        const listed = await Worktree.list()
        expect(listed.some((entry) => entry.directory === legacy)).toBe(true)

        await Worktree.remove({ directory: legacy })
        const afterRemove = await Worktree.lookupBySlug(path.basename(legacy))
        expect(afterRemove).toBeUndefined()
      })
    })

    test("rejects existing paths that are not attached git worktrees", async () => {
      await using tmp = await tmpdir({ git: true })
      const unrelated = path.join(tmp.path, "not-a-worktree")
      await fs.mkdir(unrelated, { recursive: true })

      await expect(withInstance(tmp.path, () => Worktree.registerExistingByPath(unrelated))).rejects.toThrow(
        "WorktreeCreateFailedError",
      )

      const entry = await withInstance(tmp.path, () => Worktree.lookupByDirectory(unrelated))
      expect(entry).toBeUndefined()
    })
  })

  describe("remove edge cases", () => {
    test("remove non-existent directory succeeds silently", async () => {
      await using tmp = await tmpdir({ git: true })

      const ok = await withInstance(tmp.path, () =>
        Worktree.remove({ directory: path.join(tmp.path, "does-not-exist") }),
      )
      expect(ok).toBe(true)
    })

    test("throws NotGitError for non-git directories", async () => {
      await using tmp = await tmpdir()

      await expect(withInstance(tmp.path, () => Worktree.remove({ directory: "/tmp/fake" }))).rejects.toThrow(
        "WorktreeNotGitError",
      )
    })
  })
})
