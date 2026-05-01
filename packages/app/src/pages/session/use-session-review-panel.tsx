import { Select } from "@opencode-ai/ui/select"
import { checksum } from "@opencode-ai/util/encode"
import { createEffect, createMemo, on, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { useComments } from "@/context/comments"
import type { useFile } from "@/context/file"
import type { useLanguage } from "@/context/language"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { nextFilesPanelAutoOpen } from "@/pages/session/files-tab-state"
import { createOpenReviewFile } from "@/pages/session/helpers"
import { isVcsReviewMode, reviewModeLabelKey, type ReviewChangeMode } from "@/pages/session/review-change-mode"
import { SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
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
  timelineDiffs: () => unknown[]
  turnDiffs: () => unknown[]
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
      source as never[],
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

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      input.sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

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

  const changesTitle = () => {
    if (!input.canReview()) return null

    const label = (option: ReviewChangeMode) => input.language.t(reviewModeLabelKey(option))

    return (
      <Select
        options={input.reviewState.changesOptions()}
        current={input.reviewState.changes()}
        label={label}
        onSelect={(option) => option && input.reviewState.setChanges(option)}
        variant="ghost"
        size="small"
        valueClass="text-13-medium"
      />
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-13-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    const changes = input.reviewState.changes()
    if (changes === "unstaged") return input.language.t("session.review.noUnstagedChanges")
    if (changes === "staged") return input.language.t("session.review.noStagedChanges")
    if (changes === "branch") return input.language.t("session.review.noBranchChanges")
    return input.language.t("session.review.noChanges")
  })

  const reviewEmpty = (emptyInput: { loadingClass: string; emptyClass: string }) => {
    const changes = input.reviewState.changes()
    if (isVcsReviewMode(changes)) {
      if (!input.reviewState.reviewReady()) {
        return <div class={emptyInput.loadingClass}>{input.language.t("session.review.loadingChanges")}</div>
      }
      return empty(reviewEmptyText())
    }

    if (changes === "turn") return empty(reviewEmptyText())

    return (
      <div class={emptyInput.emptyClass}>
        <div class="text-13-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: input.language.t("common.moreOptions"),
    editLabel: input.language.t("common.edit"),
    deleteLabel: input.language.t("common.delete"),
    saveLabel: input.language.t("common.save"),
  }))

  const reviewContent = (contentInput: {
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }): JSX.Element => (
    <Show when={!input.deferRender()}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(contentInput)}
        diffs={input.reviewState.reviewDiffs}
        view={input.view}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => input.commentContext.add({ ...comment, origin: "review" })}
        onLineCommentUpdate={input.commentContext.update}
        onLineCommentDelete={input.commentContext.remove}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: input.file.searchFilesAndDirectories,
        }}
        comments={input.comments.all()}
        focusedComment={input.comments.focus()}
        onFocusedCommentChange={input.comments.setFocus}
        onViewFile={openReviewFile}
        classes={contentInput.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  const mobileFallback = () =>
    reviewContent({
      classes: {
        root: "pb-8",
        header: "px-4",
        container: "px-4",
      },
      loadingClass: "px-4 py-4 text-text-weak",
      emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
    })

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    input.view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!input.reviewState.reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
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
    reviewContent,
    reviewPanel,
    mobileFallback,
    files: input.reviewState.artifactFiles,
    diffs: input.reviewState.reviewDiffs,
    hasReview: input.reviewState.hasReview,
    reviewCount: input.reviewState.reviewCount,
  }
}
