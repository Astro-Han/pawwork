import { effectiveWorkspaceOrder, workspaceKey } from "@/pages/layout/helpers"
import { getFilename } from "@opencode-ai/util/path"

export type WorkspaceEntry = string | { directory: string }

export type WorkspaceProject = {
  worktree: string
  sandboxes?: WorkspaceEntry[]
}

function workspacePath(entry: WorkspaceEntry) {
  return typeof entry === "string" ? entry : entry.directory
}

export function findWorkspaceProject(projects: WorkspaceProject[], directory?: string) {
  if (!directory) return
  const key = workspaceKey(directory)
  return projects.find(
    (item) =>
      workspaceKey(item.worktree) === key ||
      item.sandboxes?.some((sandbox) => workspaceKey(workspacePath(sandbox)) === key),
  )
}

export type WorkspaceChoiceKind = "direct-start" | "workspace"

export type WorkspaceChoice = {
  path: string
  kind: WorkspaceChoiceKind
}

export function isDirectStartWorkspacePath(path: string | undefined, directStartDirectory?: string) {
  return !!path && !!directStartDirectory && workspaceKey(path) === workspaceKey(directStartDirectory)
}

export function workspaceChipChoices(input: {
  directory?: string
  directStartDirectory?: string
  projects: WorkspaceProject[]
}): WorkspaceChoice[] {
  const directory = input.directory

  const currentIsDirectStart = isDirectStartWorkspacePath(directory, input.directStartDirectory)
  const current = currentIsDirectStart ? undefined : findWorkspaceProject(input.projects, directory)
  const seen = new Set<string>()
  const choices: WorkspaceChoice[] = []

  const append = (value: WorkspaceEntry, kind: WorkspaceChoiceKind = "workspace") => {
    const path = workspacePath(value)
    const key = workspaceKey(path)
    if (seen.has(key)) return
    seen.add(key)
    choices.push({ path, kind })
  }

  if (input.directStartDirectory) append(input.directStartDirectory, "direct-start")
  if (!directory) {
    for (const project of input.projects) append(project.worktree)
    return choices
  }

  if (!current && !currentIsDirectStart) append(directory)

  const roots = input.projects.map((project) => project.worktree)
  const ordered = current ? effectiveWorkspaceOrder(current.worktree, roots) : roots
  for (const item of ordered) append(item)

  return choices
}

export function workspaceChipLabel(input: {
  directory?: string
  directStartDirectory?: string
  directStartLabel: string
  emptyLabel: string
}) {
  if (!input.directory) {
    return input.directStartDirectory ? input.directStartLabel : input.emptyLabel
  }
  if (isDirectStartWorkspacePath(input.directory, input.directStartDirectory)) {
    return input.directStartLabel
  }
  return getFilename(input.directory) || input.emptyLabel
}

export function workspaceChipIconName(input: { directory?: string; directStartDirectory?: string }) {
  if (isDirectStartWorkspacePath(input.directory, input.directStartDirectory)) return "bubble-5"
  if (!input.directory && input.directStartDirectory) return "bubble-5"
  return "folder"
}
