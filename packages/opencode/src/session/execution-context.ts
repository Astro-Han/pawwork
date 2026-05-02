import fs from "node:fs"
import path from "path"
import z from "zod"

export const ActiveWorktree = z.object({
  directory: z.string(),
  name: z.string(),
  branch: z.string(),
  source: z.enum(["created", "existing"]),
})
export type ActiveWorktree = z.infer<typeof ActiveWorktree>

export const SessionExecutionContext = z.object({
  ownerDirectory: z.string(),
  activeDirectory: z.string(),
  activeWorktree: ActiveWorktree.optional(),
  lastChangedAt: z.number(),
})
export type SessionExecutionContext = z.infer<typeof SessionExecutionContext>

export function canonicalDirectory(input: string) {
  const abs = path.resolve(input)
  const real = (() => {
    try {
      return fs.realpathSync.native(abs)
    } catch {
      return abs
    }
  })()
  const normalized = path.normalize(real)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function rootContext(ownerDirectory: string): SessionExecutionContext {
  const directory = canonicalDirectory(ownerDirectory)
  return {
    ownerDirectory: directory,
    activeDirectory: directory,
    lastChangedAt: Date.now(),
  }
}
