import { promises as fs } from "fs"
import path from "path"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Process } from "../util/process"

export const GitignoreGuardError = NamedError.create(
  "WorktreeGitignoreGuardError",
  z.object({
    message: z.string(),
  }),
)

const ENTRY = ".worktrees/"

async function git(root: string, args: string[]) {
  const result = await Process.text(["git", ...args], { cwd: root, nothrow: true })
  return {
    code: result.code,
    stdout: result.text,
    stderr: result.stderr.toString(),
  }
}

function hasWorktreesIgnore(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .some(
      (line) => line === ".worktrees" || line === ".worktrees/" || line === "/.worktrees" || line === "/.worktrees/",
    )
}

export async function ensureWorktreesIgnored(
  root: string,
): Promise<{ changed: boolean; file: string; before?: string }> {
  const file = path.join(root, ".gitignore")
  const before = await fs.readFile(file, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })

  if (before && hasWorktreesIgnore(before)) return { changed: false, file }

  const status = await git(root, [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "status.showUntrackedFiles=all",
    "status",
    "--porcelain=v1",
    "--no-renames",
    "--",
    ".gitignore",
  ])
  if (status.code !== 0) {
    throw new GitignoreGuardError({
      message: status.stderr || status.stdout || "Failed to inspect .gitignore status",
    })
  }
  if (status.stdout.trim()) {
    throw new GitignoreGuardError({
      message: ".gitignore has local changes. Commit or discard them before creating a PawWork worktree.",
    })
  }

  const prefix = before && before.length > 0 && !before.endsWith("\n") ? "\n" : ""
  const next = `${before ?? ""}${prefix}${ENTRY}\n`
  await fs.writeFile(file, next)
  return { changed: true, file, before }
}

export async function restoreWorktreesIgnored(change: { changed: boolean; file: string; before?: string }) {
  if (!change.changed) return
  if (change.before === undefined) {
    await fs.rm(change.file, { force: true })
    return
  }
  await fs.writeFile(change.file, change.before)
}
