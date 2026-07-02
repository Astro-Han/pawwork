import type { useLayout } from "@/context/layout"
import type { useGlobalSync } from "@/context/global-sync"
import type { createCurrentProjectMemo } from "./layout-current-project"
import type { createPawworkRoutingActions } from "./pawwork-routing-actions"

export function createNavigateProjectByOffset(input: {
  layout: Pick<ReturnType<typeof useLayout>, "projects">
  currentProject: ReturnType<typeof createCurrentProjectMemo>
  currentDir: () => string
  projectRoot: (directory: string) => string
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "child">
  openProject: ReturnType<typeof createPawworkRoutingActions>["openProject"]
}): (offset: number) => void {
  return function navigateProjectByOffset(offset: number) {
    const projects = input.layout.projects.list()
    if (projects.length === 0) return

    const current = input.currentProject()?.worktree
    const fallback = input.currentDir() ? input.projectRoot(input.currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    input.globalSync.child(target.worktree)
    input.openProject(target.worktree)
  }
}
