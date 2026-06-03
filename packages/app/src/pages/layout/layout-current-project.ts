import { createMemo } from "solid-js"
import type { useLayout } from "@/context/layout"
import type { useGlobalSync } from "@/context/global-sync"
import { workspaceKey } from "./helpers"

export function createCurrentProjectMemo(input: {
  currentDir: () => string
  layout: Pick<ReturnType<typeof useLayout>, "projects">
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "child" | "data">
}) {
  return createMemo(() => {
    const directory = input.currentDir()
    if (!directory) return
    const key = workspaceKey(directory)

    const projects = input.layout.projects.list()

    const sandbox = projects.find((p) => p.sandboxes?.some((item) => workspaceKey(item) === key))
    if (sandbox) return sandbox

    const direct = projects.find((p) => workspaceKey(p.worktree) === key)
    if (direct) return direct

    const [child] = input.globalSync.child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = input.globalSync.data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })
}
