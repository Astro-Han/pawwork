import type { LocalProject } from "@/context/layout"
import { getFilename } from "@opencode-ai/util/path"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { effectiveWorkspaceOrder, workspaceKey } from "./helpers"

type ProjectLike = {
  name?: string
  worktree: string
}

type SessionLike = {
  id: string
  created: number
  projectLabel: string
}

const shortenHome = (value: string, home?: string) => {
  if (!home) return value
  const normalized = home.endsWith("/") ? home : `${home}/`
  if (!value.startsWith(normalized)) return value
  return `~/${value.slice(normalized.length)}`
}

export function resolvePawworkProjectLabels<T extends ProjectLike>(projects: T[], home?: string) {
  const counts = new Map<string, number>()
  for (const project of projects) {
    const label = project.name || getFilename(project.worktree)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  const labels = new Map<string, string>()
  for (const project of projects) {
    const label = project.name || getFilename(project.worktree)
    labels.set(project.worktree, (counts.get(label) ?? 0) > 1 ? shortenHome(project.worktree, home) : label)
  }
  return labels
}

export function sortPawworkSidebarSessions<T extends SessionLike>(sessions: T[]) {
  return sessions.slice().sort((a, b) => {
    const created = b.created - a.created
    if (created !== 0) return created
    const project = a.projectLabel.localeCompare(b.projectLabel)
    if (project !== 0) return project
    return a.id.localeCompare(b.id)
  })
}

export function pawworkSessionDirectories(input: {
  project: LocalProject | undefined
  activeProjectWorktree?: string
  currentDirectory?: string
  workspaceOrder?: string[]
}) {
  const project = input.project
  if (!project) return []

  const local = project.worktree
  const dirs = [local, ...(project.sandboxes ?? [])]
  const directory =
    input.activeProjectWorktree && workspaceKey(input.activeProjectWorktree) === workspaceKey(project.worktree)
      ? input.currentDirectory
      : undefined
  const extra =
    directory &&
    workspaceKey(directory) !== workspaceKey(local) &&
    !dirs.some((item) => workspaceKey(item) === workspaceKey(directory))
      ? directory
      : undefined
  const pending = extra ? WorktreeState.get(extra)?.status === "pending" : false

  const ordered = effectiveWorkspaceOrder(local, dirs, input.workspaceOrder)
  if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
  if (!extra) return ordered
  if (pending) return ordered
  return [...ordered, extra]
}
