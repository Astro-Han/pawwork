import { makeEventListener } from "@solid-primitives/event-listener"
import { onMount } from "solid-js"
import { focusTerminalById, shouldFocusTerminalOnKeyDown } from "@/pages/session/helpers"

export function useSessionKeyboardFocus(input: {
  blocked: () => boolean
  dialogActive: () => boolean
  inputRef: () => HTMLDivElement | undefined
  isChildSession: () => boolean
  markScrollGesture: (target?: EventTarget | null) => void
  terminalActive: () => string | undefined
  terminalOpened: () => boolean
}) {
  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (input.dialogActive()) return

    const composer = input.inputRef()
    if (activeElement === composer) {
      if (event.key === "Escape") composer?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus.
    if (input.terminalOpened()) {
      const id = input.terminalActive()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential user scroll gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      input.markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (input.blocked() || input.isChildSession()) return
      composer?.focus()
    }
  }

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })
}
