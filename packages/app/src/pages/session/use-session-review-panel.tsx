import { createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import type { useComments } from "@/context/comments"
import type { useFile } from "@/context/file"
import type { useLanguage } from "@/context/language"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { nextFilesPanelAutoOpen } from "@/pages/session/files-tab-state"
import { createOpenReviewFile } from "@/pages/session/helpers"
import { createReviewPanelScroll } from "@/pages/session/review-panel-scroll"
import { createReviewPanelView } from "@/pages/session/review-panel-view"
import type { useSessionLayout } from "@/pages/session/session-layout"
import type { createSessionCommentContext } from "@/pages/session/use-session-comment-context"
import type { createSessionReviewState } from "@/pages/session/use-session-review-state"

export function createSessionReviewPanel(input: {
  activeFileTab: () => string | undefined
  canReview: () => boolean
  comments: ReturnType<typeof useComments>
  commentContext: ReturnType<typeof createSessionCommentContext>
  deferRender: () => boolean
  file: ReturnType<typeof useFile>
  isDesktop: () => boolean
  language: ReturnType<typeof useLanguage>
  reviewState: ReturnType<typeof createSessionReviewState>
  routeSessionID: () => string | undefined
  sdk: ReturnType<typeof useSDK>
  sessionKey: () => string
  sync: ReturnType<typeof useSync>
  timelineDiffs: () => Array<{ status?: string | null }>
  turnDiffs: () => Array<{ status?: string | null }>
  view: ReturnType<typeof useSessionLayout>["view"]
  wantsReview: () => boolean
  openTab: (tab: string) => void
  setActiveTab: (tab: string) => void
}) {
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createEffect(() => {
    if (!input.routeSessionID()) return

    const source = input.timelineDiffs().length > 0 ? input.timelineDiffs() : input.turnDiffs()
    const next = nextFilesPanelAutoOpen(
      {
        seenAdded: input.view().sidePanel.filesAutoOpenSeen(),
        dismissed: input.view().sidePanel.filesAutoOpenDismissed(),
      },
      source,
    )

    if (next.open) {
      input.view().sidePanel.setTab("files")
      input.view().sidePanel.open()
    }
    input.view().sidePanel.setAutoOpenState(next)
  })

  createEffect(
    on(
      () => input.sync.data.session_status[input.routeSessionID() ?? ""]?.type,
      (next, prev) => {
        const mode = input.reviewState.vcsMode()
        if (!mode) return
        if (!input.wantsReview()) return
        if (next !== "idle" || prev === undefined || prev === "idle") return
        void input.reviewState.loadVcs(mode, true)
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => input.view().sidePanel.explorer.tab()
  const setFileTreeTab = (value: "changes" | "all") => input.view().sidePanel.explorer.setTab(value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: input.file.tab,
    openTab: input.openTab,
    setActive: input.setActiveTab,
    loadFile: input.file.load,
  })

  const activeReviewPath = createMemo(() => {
    if (!input.wantsReview()) return
    const tab = input.activeFileTab()
    if (!tab) return
    const path = input.file.pathFromTab(tab)
    if (!path) return
    return input.reviewState.reviewDiffs().some((diff) => diff.file === path) ? path : undefined
  })

  const scroll = createReviewPanelScroll({
    activeReviewPath,
    reviewReady: input.reviewState.reviewReady,
    sessionKey: input.sessionKey,
    view: input.view,
  })

  const panel = createReviewPanelView({
    canReview: input.canReview,
    comments: input.comments,
    commentContext: input.commentContext,
    deferRender: input.deferRender,
    file: input.file,
    focusedFile: scroll.activeDiff,
    language: input.language,
    onScrollRef: scroll.setReviewScroll,
    onViewFile: openReviewFile,
    reviewState: input.reviewState,
    view: input.view,
  })

  createEffect(() => {
    const id = input.routeSessionID()
    if (!id) return

    if (!input.wantsReview()) return
    if (input.sync.data.session_diff[id] !== undefined) return
    if (input.sync.status === "loading") return

    void input.sync.session.diff(id)
  })

  createEffect(
    on(
      () => [input.sessionKey(), input.wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = input.routeSessionID()
        if (!id) return
        if (!untrack(() => input.sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (input.sessionKey() !== key) return
            void input.sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = input.sdk.directory
    if (!input.isDesktop()) return
    if (!input.view().sidePanel.opened()) return
    if (input.view().sidePanel.tab() !== "review") return
    if (input.sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? input.file.tree.refresh("") : input.file.tree.list(""))
  })

  createEffect(
    on(
      () => input.sdk.directory,
      () => {
        const tab = input.activeFileTab()
        if (!tab) return
        const path = input.file.pathFromTab(tab)
        if (!path) return
        void input.file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
  })

  return {
    reviewContent: panel.reviewContent,
    reviewPanel: panel.reviewPanel,
    mobileFallback: panel.mobileFallback,
    files: input.reviewState.artifactFiles,
    diffs: input.reviewState.reviewDiffs,
    hasReview: input.reviewState.hasReview,
    reviewCount: input.reviewState.reviewCount,
  }
}
