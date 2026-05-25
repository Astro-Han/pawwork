import { createEffect, on, onCleanup, untrack } from "solid-js"
import type { VcsReviewMode } from "@/pages/session/review-change-mode"
import { same } from "@/utils/same"

export function useSessionVcsRefresh(input: {
  directory: () => string
  event: {
    listen: (handler: (event: { details: { type: string; properties?: unknown } }) => void) => () => void
  }
  branch: () => string | undefined
  defaultBranch: () => string | undefined
  reset: () => void
  mode: () => VcsReviewMode | undefined
  wantsReview: () => boolean
  load: (mode: VcsReviewMode, force: true) => void | Promise<void>
}) {
  const refresh = () => {
    input.reset()
    const mode = untrack(input.mode)
    if (!mode) return
    if (!untrack(input.wantsReview)) return
    void input.load(mode, true)
  }

  createEffect(
    on(
      input.directory,
      () => {
        input.reset()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.branch(), input.defaultBranch()] as const,
      (next, prev) => {
        if (prev === undefined || same(next, prev)) return
        refresh()
      },
      { defer: true },
    ),
  )

  const stop = input.event.listen((evt) => {
    if (!isFileWatcherVcsRefreshEvent(evt.details)) return
    refresh()
  })
  onCleanup(stop)
}

export function isFileWatcherVcsRefreshEvent(event: { type: string; properties?: unknown }) {
  if (event.type === "file.watcher.rescan") return true
  if (event.type !== "file.watcher.updated") return false
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const file = typeof props?.file === "string" ? props.file.replaceAll("\\", "/") : undefined
  if (!file) return false
  if (!file.startsWith(".git/")) return true
  return (
    file === ".git/index" ||
    file === ".git/HEAD" ||
    file === ".git/packed-refs" ||
    file.startsWith(".git/refs/heads/") ||
    file.startsWith(".git/refs/remotes/") ||
    file.startsWith(".git/logs/HEAD") ||
    file.startsWith(".git/worktrees/")
  )
}
