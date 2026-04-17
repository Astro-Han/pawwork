import { describe, expect, mock, test } from "bun:test"
import { $ } from "bun"
import { promises as nodeFs } from "node:fs"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

let rmCalls = 0
let failBusyTimes = 0

mock.module("fs/promises", () => {
  return {
    ...nodeFs,
    rm: async (...args: Parameters<typeof nodeFs.rm>) => {
      rmCalls += 1
      if (failBusyTimes > 0) {
        failBusyTimes -= 1
        const error = new Error("resource busy or locked")
        ;(error as NodeJS.ErrnoException).code = "EBUSY"
        throw error
      }
      return nodeFs.rm(...args)
    },
  }
})

const { Worktree } = await import("../../src/worktree")

describe("Worktree.remove cleanup", () => {
  test("retries transient busy directory cleanup after git worktree removal", async () => {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    const name = `remove-busy-${Date.now().toString(36)}`
    const branch = `opencode/${name}`
    const dir = path.join(root, "..", name)

    await $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet()
    await $`git reset --hard`.cwd(dir).quiet()

    failBusyTimes = 2
    rmCalls = 0

    const ok = await Instance.provide({
      directory: root,
      fn: () => Worktree.remove({ directory: dir }),
    })

    expect(ok).toBe(true)
    expect(rmCalls).toBeGreaterThanOrEqual(3)
    expect(await Filesystem.exists(dir)).toBe(false)
  })
})
