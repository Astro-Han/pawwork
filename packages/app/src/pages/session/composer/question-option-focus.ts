function keepVisibleInQuestionOptions(el: HTMLElement) {
  const scroller = el.closest('[data-slot="question-options"]')
  if (!(scroller instanceof HTMLElement)) return

  const optionRect = el.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  if (optionRect.top < scrollerRect.top) {
    scroller.scrollTop -= scrollerRect.top - optionRect.top
  } else if (optionRect.bottom > scrollerRect.bottom) {
    scroller.scrollTop += optionRect.bottom - scrollerRect.bottom
  }
}

export function focusWithoutScrollingTimeline(el: HTMLElement | undefined) {
  if (!el) return
  el.focus({ preventScroll: true })
  keepVisibleInQuestionOptions(el)
}
