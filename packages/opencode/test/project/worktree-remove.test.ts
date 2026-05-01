import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Worktree } from "../../src/worktree"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const wintest = process.platform === "win32" ? test : test.skip
const unixtest = process.platform === "win32" ? test.skip : test

describe("Worktree.remove", () => {
  test("refuses to remove a worktree bound to an active session", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path

    const { info, session } = await Instance.provide({
      directory: root,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("bound-session")
        await Worktree.createFromInfo(info)
        const session = await Session.create({ title: "Bound session" })
        await Session.updateExecutionContext({
          sessionID: session.id,
          activeWorktree: info,
        })
        return { info, session }
      },
    })

    await expect(
      Instance.provide({
        directory: root,
        fn: () => Worktree.remove({ directory: info.directory }),
      }),
    ).rejects.toThrow("WorktreeRemoveFailedError")
    try {
      await Instance.provide({
        directory: root,
        fn: () => Worktree.remove({ directory: info.directory }),
      })
    } catch (error) {
      expect((error as { data?: { message?: string } }).data?.message).toContain("Worktree is in use by session")
    }
    expect(await Filesystem.exists(info.directory)).toBe(true)

    await Instance.provide({
      directory: root,
      fn: async () => {
        await Session.updateExecutionContext({ sessionID: session.id, activeWorktree: null })
        await Session.remove(session.id)
        await Worktree.remove({ directory: info.directory })
      },
    })
  })

  unixtest("continues when git remove exits non-zero after detaching", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    const name = `remove-regression-${Date.now().toString(36)}`
    const branch = `opencode/${name}`
    const dir = path.join(root, "..", name)

    await $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet()
    await $`git reset --hard`.cwd(dir).quiet()

    const real = (await $`which git`.quiet().text()).trim()
    expect(real).toBeTruthy()

    const bin = path.join(root, "bin")
    const shim = path.join(bin, "git")
    await fs.mkdir(bin, { recursive: true })
    await Bun.write(
      shim,
      [
        "#!/bin/bash",
        `REAL_GIT=${JSON.stringify(real)}`,
        'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
        '  "$REAL_GIT" "$@" >/dev/null 2>&1',
        '  echo "fatal: failed to remove worktree: Directory not empty" >&2',
        "  exit 1",
        "fi",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    )
    await fs.chmod(shim, 0o755)

    const prev = process.env.PATH ?? ""
    process.env.PATH = `${bin}${path.delimiter}${prev}`

    const ok = await (async () => {
      try {
        return await Instance.provide({
          directory: root,
          fn: () => Worktree.remove({ directory: dir }),
        })
      } finally {
        process.env.PATH = prev
      }
    })()

    expect(ok).toBe(true)
    expect(await Filesystem.exists(dir)).toBe(false)

    const list = await $`git worktree list --porcelain`.cwd(root).quiet().text()
    expect(list).not.toContain(`worktree ${dir}`)

    const ref = await $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow()
    expect(ref.exitCode).not.toBe(0)
  })

  unixtest("removes registry entry when branch deletion fails after directory cleanup", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    const info = await Instance.provide({
      directory: root,
      fn: async () => {
        const info = await Worktree.makeWorktreeInfo("branch-delete-fails")
        await Worktree.createFromInfo(info)
        return info
      },
    })

    const real = (await $`which git`.quiet().text()).trim()
    expect(real).toBeTruthy()

    const bin = path.join(root, "bin")
    const shim = path.join(bin, "git")
    await fs.mkdir(bin, { recursive: true })
    await Bun.write(
      shim,
      [
        "#!/bin/bash",
        `REAL_GIT=${JSON.stringify(real)}`,
        'if [ "$1" = "branch" ] && [ "$2" = "-D" ]; then',
        '  echo "fatal: could not delete branch" >&2',
        "  exit 1",
        "fi",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    )
    await fs.chmod(shim, 0o755)

    const prev = process.env.PATH ?? ""
    process.env.PATH = `${bin}${path.delimiter}${prev}`

    try {
      await expect(
        Instance.provide({
          directory: root,
          fn: () => Worktree.remove({ directory: info.directory }),
        }),
      ).rejects.toThrow("WorktreeRemoveFailedError")
    } finally {
      process.env.PATH = prev
    }

    expect(await Filesystem.exists(info.directory)).toBe(false)
    const registryEntry = await Instance.provide({
      directory: root,
      fn: () => Worktree.lookupByDirectory(info.directory),
    })
    expect(registryEntry).toBeUndefined()

    await $`git branch -D ${info.branch}`.cwd(root).quiet().nothrow()
  })

  wintest("stops fsmonitor before removing a worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    const name = `remove-fsmonitor-${Date.now().toString(36)}`
    const branch = `opencode/${name}`
    const dir = path.join(root, "..", name)

    await $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet()
    await $`git reset --hard`.cwd(dir).quiet()
    await $`git config core.fsmonitor true`.cwd(dir).quiet()
    await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
    await Bun.write(path.join(dir, "tracked.txt"), "next\n")
    await $`git diff`.cwd(dir).quiet()

    const before = await $`git fsmonitor--daemon status`.cwd(dir).quiet().nothrow()
    expect(before.exitCode).toBe(0)

    const ok = await Instance.provide({
      directory: root,
      fn: () => Worktree.remove({ directory: dir }),
    })

    expect(ok).toBe(true)
    expect(await Filesystem.exists(dir)).toBe(false)

    const ref = await $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(root).quiet().nothrow()
    expect(ref.exitCode).not.toBe(0)
  })
})
