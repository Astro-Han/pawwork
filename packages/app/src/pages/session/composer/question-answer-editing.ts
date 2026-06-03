import type { SetStoreFunction } from "solid-js/store"
import type { QuestionStore } from "./question-draft"

type AnswerEditingDeps = {
  store: QuestionStore
  setStore: SetStoreFunction<QuestionStore>
  input: () => string
  on: () => boolean
  multi: () => boolean
  optionCount: () => number
  canInteract: () => boolean
  focus: (index: number) => void
}

export function createQuestionAnswerEditing(deps: AnswerEditingDeps) {
  const { store, setStore, input, on, multi, optionCount, canInteract, focus } = deps

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed.length ? removed : undefined
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : undefined)
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) {
        const next = current.filter((item) => item !== answer)
        return next.length ? next : undefined
      }
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (!canInteract()) return
    setStore("focus", optionCount())

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) {
      setStore("answers", store.tab, (current = []) => {
        const next = current.filter((item) => item.trim() !== value)
        return next.length ? next : undefined
      })
    }
    setStore("editing", false)
    focus(optionCount())
  }

  const customOpen = () => {
    if (!canInteract()) return
    setStore("focus", optionCount())
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(optionCount())
  }

  return { customUpdate, picked, pick, toggle, customToggle, customOpen, commitCustom }
}
