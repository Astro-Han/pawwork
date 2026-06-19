import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { NodePath } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Path } from "effect"
import { Git } from "../../src/git"
import { ensureWorktreesIgnoredEffect } from "../../src/worktree/gitignore-guard"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Git.defaultLayer, NodePath.layer, CrossSpawnSpawner.defaultLayer),
)

function guardFailsWithName(exit: Exit.Exit<unknown, unknown>, name: string) {
  if (Exit.isSuccess(exit)) return false
  return Cause.prettyErrors(exit.cause).some(
    (error) => error instanceof Error && (error.name === name || error.message.includes(name)),
  )
}

const gitOk = Effect.fnUntraced(function* (root: string, args: string[]) {
  const git = yield* Git.Service
  const result = yield* git.run(args, { cwd: root })
  expect(result.exitCode).toBe(0)
})

describe("worktree gitignore guard", () => {
  it.live("creates .gitignore with .worktrees entry when missing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path

      const result = yield* ensureWorktreesIgnoredEffect(tmp)

      expect(result.changed).toBe(true)
      expect(yield* fs.readFileString(path.join(tmp, ".gitignore"))).toBe(".worktrees/\n")
    }),
  )

  it.live("does not duplicate existing .worktrees entry", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path
      const file = path.join(tmp, ".gitignore")
      yield* fs.writeFileString(file, "node_modules\n/.worktrees/\n")
      yield* gitOk(tmp, ["add", ".gitignore"])
      yield* gitOk(tmp, ["commit", "-m", "ignore-worktrees"])

      const result = yield* ensureWorktreesIgnoredEffect(tmp)

      expect(result.changed).toBe(false)
      expect(yield* fs.readFileString(file)).toBe("node_modules\n/.worktrees/\n")
    }),
  )

  it.live("refuses to append when .gitignore has local changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path
      const file = path.join(tmp, ".gitignore")
      yield* fs.writeFileString(file, "node_modules\n")
      yield* gitOk(tmp, ["add", ".gitignore"])
      yield* gitOk(tmp, ["commit", "-m", "initial-gitignore"])
      yield* fs.writeFileString(file, "node_modules\ndist\n")

      const exit = yield* Effect.exit(ensureWorktreesIgnoredEffect(tmp))

      expect(guardFailsWithName(exit, "WorktreeGitignoreGuardError")).toBe(true)
    }),
  )

  it.live("refuses to append when untracked .gitignore is hidden by git config", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path
      yield* gitOk(tmp, ["config", "status.showUntrackedFiles", "no"])
      yield* fs.writeFileString(path.join(tmp, ".gitignore"), "node_modules\n")

      const exit = yield* Effect.exit(ensureWorktreesIgnoredEffect(tmp))

      expect(guardFailsWithName(exit, "WorktreeGitignoreGuardError")).toBe(true)
    }),
  )

  it.live("refuses to recreate a locally deleted tracked .gitignore", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path
      const file = path.join(tmp, ".gitignore")
      yield* fs.writeFileString(file, "node_modules\n")
      yield* gitOk(tmp, ["add", ".gitignore"])
      yield* gitOk(tmp, ["commit", "-m", "initial-gitignore"])
      yield* fs.remove(file)

      const exit = yield* Effect.exit(ensureWorktreesIgnoredEffect(tmp))

      expect(guardFailsWithName(exit, "WorktreeGitignoreGuardError")).toBe(true)
    }),
  )
})
