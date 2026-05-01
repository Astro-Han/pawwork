import { effectiveWorkspaceOrder, workspaceKey } from "@/pages/layout/helpers"

export type WorkspaceEntry = string | { directory: string; branch?: string }

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
  branch?: string
}

export function workspaceChipChoices(input: {
  directory?: string
  projects: WorkspaceProject[]
  listed?: WorkspaceEntry[]
}): WorkspaceChoice[] {
  const directory = input.directory
  if (!directory) return []

  const current = findWorkspaceProject(input.projects, directory)
  const seen = new Set<string>()
  const choices: WorkspaceChoice[] = []
  const branchByPath = new Map<string, string | undefined>()

  const remember = (value: WorkspaceEntry) => {
    if (typeof value === "string") return
    branchByPath.set(workspaceKey(value.directory), value.branch)
  }

  for (const item of input.listed ?? []) remember(item)
  for (const project of input.projects) {
    for (const item of project.sandboxes ?? []) remember(item)
  }

  const append = (value: WorkspaceEntry) => {
    const path = workspacePath(value)
    const key = workspaceKey(path)
    if (seen.has(key)) return
    seen.add(key)
    choices.push({ path, branch: typeof value === "string" ? branchByPath.get(key) : value.branch })
  }

  if (!current) append(directory)

  for (const project of input.projects) {
    const ordered =
      current && workspaceKey(project.worktree) === workspaceKey(current.worktree)
        ? effectiveWorkspaceOrder(project.worktree, [
            project.worktree,
            ...(project.sandboxes ?? []).map(workspacePath),
            ...(input.listed ?? []).map(workspacePath),
          ])
        : [project.worktree, ...(project.sandboxes ?? [])]

    for (const item of ordered) append(item)
  }

  if (current && !choices.some((item) => workspaceKey(item.path) === workspaceKey(directory))) {
    choices.unshift({ path: directory })
  }

  return choices
}
