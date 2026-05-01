import { effectiveWorkspaceOrder, workspaceKey } from "@/pages/layout/helpers"

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

export type WorkspaceChoice = {
  path: string
}

export function workspaceChipChoices(input: {
  directory?: string
  projects: WorkspaceProject[]
}): WorkspaceChoice[] {
  const directory = input.directory
  if (!directory) return []

  const current = findWorkspaceProject(input.projects, directory)
  const seen = new Set<string>()
  const choices: WorkspaceChoice[] = []

  const append = (value: WorkspaceEntry) => {
    const path = workspacePath(value)
    const key = workspaceKey(path)
    if (seen.has(key)) return
    seen.add(key)
    choices.push({ path })
  }

  if (!current) append(directory)

  const roots = input.projects.map((project) => project.worktree)
  const ordered = current ? effectiveWorkspaceOrder(current.worktree, roots) : roots
  for (const item of ordered) append(item)

  return choices
}
