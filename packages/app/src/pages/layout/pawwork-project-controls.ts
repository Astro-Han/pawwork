import { reconcile, type SetStoreFunction } from "solid-js/store"
import type { LocalProject } from "@/context/layout"
import { reorderPawworkPinnedByVisible, unpinPawworkSession } from "./pawwork-session-nav"
import { resolvePawworkProjectRenameTarget } from "./pawwork-session-source"
import { createDefaultLayoutPageState } from "./layout-page-store"

type LayoutPageState = ReturnType<typeof createDefaultLayoutPageState>

export type PawworkProjectControlsInput = {
  store: LayoutPageState
  setStore: SetStoreFunction<LayoutPageState>
  projects: () => LocalProject[]
  sessions: () => { directory: string }[]
  renameProject: (project: LocalProject, next: string) => Promise<void>
  setWorkspaceName: (directory: string, next: string) => void
}

export function createPawworkProjectControls(input: PawworkProjectControlsInput) {
  function togglePinnedSession(sessionID: string) {
    input.setStore("pawworkPinnedSessions", (current) => {
      const next = current.filter((id) => id !== sessionID)
      if (next.length !== current.length) return next
      return [sessionID, ...current]
    })
  }

  /**
   * Cross-zone drag: All ⇄ Pinned with positional insert, or intra-Pinned
   * reorder. `visiblePinnedIDs` is the rendered pinned order from the sidebar;
   * `visibleTargetIndex` is a slot inside it. We translate to the raw
   * pinned array so hidden / un-loaded pinned IDs keep their positions.
   */
  function dragPawworkSession(args: {
    sessionID: string
    targetSection: "pinned" | "recent"
    visiblePinnedIDs: string[]
    visibleTargetIndex: number
  }) {
    input.setStore("pawworkPinnedSessions", (current) => {
      if (args.targetSection === "recent") {
        return unpinPawworkSession({ pinnedIDs: current, sourceID: args.sessionID })
      }
      return reorderPawworkPinnedByVisible({
        pinnedIDs: current,
        visiblePinnedIDs: args.visiblePinnedIDs,
        sourceID: args.sessionID,
        targetVisibleIndex: args.visibleTargetIndex,
      })
    })
  }

  /**
   * Menu-driven move up / down: keyboard-accessible reorder within the pinned
   * zone. Operates on the visible pinned order so adjacency matches what the
   * user sees; the helper reconciles back to the raw array.
   */
  function movePinnedSessionByOne(args: {
    sessionID: string
    direction: "up" | "down"
    visiblePinnedIDs: string[]
  }) {
    const visibleIndex = args.visiblePinnedIDs.indexOf(args.sessionID)
    if (visibleIndex === -1) return
    const offset = args.direction === "up" ? -1 : 1
    const nextVisibleIndex = Math.max(0, Math.min(args.visiblePinnedIDs.length - 1, visibleIndex + offset))
    if (nextVisibleIndex === visibleIndex) return
    input.setStore("pawworkPinnedSessions", (current) =>
      reorderPawworkPinnedByVisible({
        pinnedIDs: current,
        visiblePinnedIDs: args.visiblePinnedIDs,
        sourceID: args.sessionID,
        targetVisibleIndex: nextVisibleIndex,
      }),
    )
  }

  function setPawworkSortMode(mode: "time" | "project") {
    input.setStore("pawworkSortMode", mode)
  }

  function toggleProjectCollapsed(label: string) {
    const current = input.store.pawworkProjectCollapsed
    const next: Record<string, boolean> = { ...current }
    if (next[label]) delete next[label]
    else next[label] = true
    input.setStore("pawworkProjectCollapsed", reconcile(next))
  }

  async function handleRenameProject(projectKey: string, next: string) {
    const target = resolvePawworkProjectRenameTarget(projectKey, {
      projects: input.projects(),
      sessions: input.sessions(),
    })
    if (!target) return

    if (target.type === "project") {
      await input.renameProject(target.project, next)
      return
    }

    input.setWorkspaceName(target.directory, next)
  }

  function expandPawworkProjectGroup(label: string | undefined) {
    if (!label) return
    if (!input.store.pawworkProjectCollapsed[label]) return

    const next: Record<string, boolean> = { ...input.store.pawworkProjectCollapsed }
    delete next[label]
    input.setStore("pawworkProjectCollapsed", reconcile(next))
  }

  return {
    togglePinnedSession,
    dragPawworkSession,
    movePinnedSessionByOne,
    setPawworkSortMode,
    toggleProjectCollapsed,
    handleRenameProject,
    expandPawworkProjectGroup,
  }
}
