// Review-panel comment jump routing. Lives separately from the composer
// because clicking a context item or review comment opens panels and switches
// tabs — none of which is composer-internal logic.

import { createMemo } from "solid-js"
import { useFile } from "@/context/file"
import { useComments } from "@/context/comments"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { isAbsoluteLike, isUnderDirectory } from "./path-canonical"

export interface CommentRoutingDeps {
  activeSessionID: () => string | undefined
}

export interface CommentRouting {
  recent: () => string[]
  openComment: (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => void
}

export function createCommentRouting(deps: CommentRoutingDeps): CommentRouting {
  // tabs/view come from useSessionLayout (no separate useTabs/useView hooks)
  const { tabs, view } = useSessionLayout()
  const files = useFile()
  const comments = useComments()
  const sync = useSync()
  const sdk = useSDK()

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = deps.activeSessionID()
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    // Belt-and-suspenders: reject external absolute paths so we never try to
    // open a same-named file that happens to live inside the current workspace.
    if (isAbsoluteLike(item.path) && !isUnderDirectory(item.path, sdk.directory)) return

    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    view().sidePanel.openTab("review")
    if (wantsReview) {
      view().sidePanel.explorer.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    view().sidePanel.explorer.setTab("all")
    const tab = files.tab(item.path)
    tabs().open(tab)
    tabs().setActive(tab)
    Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })

  return { recent, openComment }
}
