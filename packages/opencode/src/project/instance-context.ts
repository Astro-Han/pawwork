import { Filesystem } from "@/util/filesystem"
import { LocalContext } from "@/util/local-context"
import type { Project } from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

export function containsPath(filepath: string, ctx: InstanceContext) {
  if (Filesystem.contains(ctx.directory, filepath)) return true
  if (ctx.worktree === "/") return false
  return Filesystem.contains(ctx.worktree, filepath)
}
