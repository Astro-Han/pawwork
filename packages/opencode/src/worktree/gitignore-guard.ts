import { Effect, Path } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import z from "zod"
import { Git } from "@/git"

export const GitignoreGuardError = NamedError.create(
  "WorktreeGitignoreGuardError",
  z.object({
    message: z.string(),
  }),
)

const ENTRY = ".worktrees/"

function hasWorktreesIgnore(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .some(
      (line) => line === ".worktrees" || line === ".worktrees/" || line === "/.worktrees" || line === "/.worktrees/",
    )
}

export type GitignoreGuardChange = { changed: boolean; file: string; before?: string }

export const ensureWorktreesIgnoredEffect = Effect.fn("Worktree.ensureWorktreesIgnored")(function* (root: string) {
  const fs = yield* AppFileSystem.Service
  const path = yield* Path.Path
  const git = yield* Git.Service
  const file = path.join(root, ".gitignore")
  const before = yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  )

  if (before && hasWorktreesIgnore(before)) return { changed: false, file }

  const status = yield* git.run(
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "status.showUntrackedFiles=all",
      "status",
      "--porcelain=v1",
      "--no-renames",
      "--",
      ".gitignore",
    ],
    { cwd: root },
  )
  const stdout = status.text()
  const stderr = status.stderr.toString()
  if (status.exitCode !== 0) {
    return yield* Effect.fail(
      new GitignoreGuardError({
        message: stderr || stdout || "Failed to inspect .gitignore status",
      }),
    )
  }
  if (stdout.trim()) {
    return yield* Effect.fail(
      new GitignoreGuardError({
        message: ".gitignore has local changes. Commit or discard them before creating a PawWork worktree.",
      }),
    )
  }

  const prefix = before && before.length > 0 && !before.endsWith("\n") ? "\n" : ""
  const next = `${before ?? ""}${prefix}${ENTRY}\n`
  yield* fs.writeFileString(file, next)
  return { changed: true, file, before }
})

export const restoreWorktreesIgnoredEffect = Effect.fn("Worktree.restoreWorktreesIgnored")(function* (
  change: GitignoreGuardChange,
) {
  if (!change.changed) return
  const fs = yield* AppFileSystem.Service
  if (change.before === undefined) {
    yield* fs.remove(change.file, { force: true })
    return
  }
  yield* fs.writeFileString(change.file, change.before)
})
