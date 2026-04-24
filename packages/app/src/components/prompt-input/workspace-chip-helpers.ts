import { effectiveWorkspaceOrder, workspaceKey } from "@/pages/layout/helpers"

export type WorkspaceProject = {
  worktree: string
  sandboxes?: string[]
}

export function findWorkspaceProject(projects: WorkspaceProject[], directory?: string) {
  if (!directory) return
  const key = workspaceKey(directory)
  return projects.find(
    (item) => workspaceKey(item.worktree) === key || item.sandboxes?.some((sandbox) => workspaceKey(sandbox) === key),
  )
}

export type WorkspaceChoice = {
  path: string
  branch?: string
}

export function workspaceChipChoices(input: {
  directory?: string
  projects: WorkspaceProject[]
  listed?: string[]
}): WorkspaceChoice[] {
  const directory = input.directory
  if (!directory) return []

  const current = findWorkspaceProject(input.projects, directory)
  const seen = new Set<string>()
  const choices: WorkspaceChoice[] = []

  const append = (value: string) => {
    const key = workspaceKey(value)
    if (seen.has(key)) return
    seen.add(key)
    choices.push({ path: value })
  }

  if (!current) append(directory)

  for (const project of input.projects) {
    const ordered =
      current && workspaceKey(project.worktree) === workspaceKey(current.worktree)
        ? effectiveWorkspaceOrder(project.worktree, [project.worktree, ...(project.sandboxes ?? []), ...(input.listed ?? [])])
        : [project.worktree, ...(project.sandboxes ?? [])]

    for (const item of ordered) append(item)
  }

  if (current && !choices.some((item) => workspaceKey(item.path) === workspaceKey(directory))) {
    choices.unshift({ path: directory })
  }

  return choices
}
