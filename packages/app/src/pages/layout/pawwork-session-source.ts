import { getFilename } from "@opencode-ai/util/path"

type ProjectLike = {
  name?: string
  worktree: string
}

type SessionLike = {
  id: string
  updated: number
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
  return sessions
    .slice()
    .sort((a, b) => b.updated - a.updated || a.projectLabel.localeCompare(b.projectLabel) || a.id.localeCompare(b.id))
}
