import { Select } from "@opencode-ai/ui/select"
import { createMemo, Show, type JSX } from "solid-js"
import type { useComments } from "@/context/comments"
import type { useFile } from "@/context/file"
import type { useLanguage } from "@/context/language"
import { isVcsReviewMode, reviewModeLabelKey, type ReviewChangeMode } from "@/pages/session/review-change-mode"
import { SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import type { useSessionLayout } from "@/pages/session/session-layout"
import type { createSessionCommentContext } from "@/pages/session/use-session-comment-context"
import type { createSessionReviewState } from "@/pages/session/use-session-review-state"

export function createReviewPanelView(input: {
  canReview: () => boolean
  comments: ReturnType<typeof useComments>
  commentContext: ReturnType<typeof createSessionCommentContext>
  deferRender: () => boolean
  file: ReturnType<typeof useFile>
  focusedFile: () => string | undefined
  language: ReturnType<typeof useLanguage>
  onScrollRef: (el: HTMLDivElement) => void
  onViewFile: (path: string) => void
  reviewState: ReturnType<typeof createSessionReviewState>
  view: ReturnType<typeof useSessionLayout>["view"]
}) {
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
        onScrollRef={input.onScrollRef}
        focusedFile={input.focusedFile()}
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
        onViewFile={input.onViewFile}
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

  return {
    reviewContent,
    reviewPanel,
    mobileFallback,
  }
}
