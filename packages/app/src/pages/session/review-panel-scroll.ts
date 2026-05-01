import { checksum } from "@opencode-ai/util/encode"
import { createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { useSessionLayout } from "@/pages/session/session-layout"

export function reviewDiffId(path: string) {
  const sum = checksum(path)
  if (!sum) return
  return `session-review-diff-${sum}`
}

export function createReviewPanelScroll(input: {
  activeReviewPath: () => string | undefined
  reviewReady: () => boolean
  sessionKey: () => string
  view: ReturnType<typeof useSessionLayout>["view"]
}) {
  const [state, setState] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  const reviewDiffTop = (path: string) => {
    const root = state.reviewScroll
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
    const root = state.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    input.view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  createEffect(
    on(
      input.sessionKey,
      () => {
        setState({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      input.activeReviewPath,
      (path) => {
        setState({
          activeDiff: path,
          pendingDiff: path,
        })
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const pending = state.pendingDiff
    if (!pending) return
    if (!state.reviewScroll) return
    if (!input.reviewReady()) return

    const attempt = (count: number) => {
      if (state.pendingDiff !== pending) return
      if (count > 60) {
        setState("pendingDiff", undefined)
        return
      }

      const root = state.reviewScroll
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
        setState("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  return {
    activeDiff: () => state.activeDiff,
    setReviewScroll: (el: HTMLDivElement) => setState("reviewScroll", el),
  }
}
