import { onCleanup } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { QuestionInfo } from "@/pages/session/blockers/running-external-result-question"
import type { QuestionStore } from "./question-draft"
import { focusWithoutScrollingTimeline } from "./question-option-focus"

type KeyboardNavDeps = {
  store: QuestionStore
  setStore: SetStoreFunction<QuestionStore>
  questions: () => QuestionInfo[]
  count: () => number
  canInteract: () => boolean
  resolveFocusTarget: (index: number) => HTMLElement | undefined
  next: () => void
  reject: () => Promise<void>
}

export function createQuestionKeyboardNav(deps: KeyboardNavDeps) {
  const { store, setStore, questions, count, canInteract, resolveFocusTarget, next, reject } = deps

  let focusFrame: number | undefined

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
  })

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    const customOnTab = questions()[tab]?.custom !== false
    if (customOnTab && store.customOn[tab] === true) return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      focusWithoutScrollingTimeline(resolveFocusTarget(next))
    })
  }

  const move = (step: number) => {
    if (store.editing || !canInteract()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      event.preventDefault()
      reject().catch(() => {})
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focus(0)
      return
    }

    if (event.key !== "End") return
    event.preventDefault()
    focus(count() - 1)
  }

  return { pickFocus, focus, nav }
}
