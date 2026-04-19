import { lazy } from "@/util/lazy"
import type { ProjectID } from "@/project/schema"
import type { Adaptor } from "../types"

const BUILTIN: Record<string, () => Promise<Adaptor>> = {
  worktree: lazy(async () => (await import("./worktree")).WorktreeAdaptor),
}

const CUSTOM = new Map<ProjectID, Map<string, Map<string, Adaptor>>>()

export function ownerKey(directory: string, worktree: string) {
  return worktree === "/" ? directory : worktree
}

export function getBuiltinAdaptor(type: string) {
  return BUILTIN[type]
}

export async function getAdaptor(projectID: ProjectID, type: string, owner?: string): Promise<Adaptor> {
  const project = CUSTOM.get(projectID)?.get(type)
  if (project) {
    if (owner) {
      const exact = project.get(owner)
      if (exact) return exact
      throw new Error(`Unknown workspace adaptor owner: ${owner} (${type})`)
    }

    const adaptors = [...project.values()]
    const latest = adaptors.at(-1)
    if (latest) return latest
  }

  const builtin = BUILTIN[type]
  if (builtin) return builtin()

  throw new Error(`Unknown workspace adaptor: ${type}`)
}

export function installAdaptor(projectID: ProjectID, owner: string, type: string, adaptor: Adaptor) {
  // This is experimental: mostly used for testing right now, but we
  // will likely allow this in the future. Need to figure out the
  // TypeScript story
  if (type in BUILTIN) {
    throw new Error(`Cannot register built-in workspace adaptor: ${type}`)
  }

  const project = CUSTOM.get(projectID) ?? new Map<string, Map<string, Adaptor>>()
  const adaptors = project.get(type) ?? new Map<string, Adaptor>()
  if (adaptors.has(owner)) adaptors.delete(owner)
  adaptors.set(owner, adaptor)
  project.set(type, adaptors)
  CUSTOM.set(projectID, project)
}

export function uninstallAdaptor(projectID: ProjectID, owner: string, type: string) {
  const project = CUSTOM.get(projectID)
  if (!project) return

  const adaptors = project.get(type)
  if (!adaptors) return

  adaptors.delete(owner)
  if (adaptors.size === 0) project.delete(type)
  if (project.size === 0) CUSTOM.delete(projectID)
}
