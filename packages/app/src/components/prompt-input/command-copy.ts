// Scoped copy handler logic for command pills and skill chips.
//
// Browser default copy on a pill yields just the visible textContent (the bare
// name, no slash). The rest of the system — Path C paste, command-line
// round-trip, cross-app paste — needs the slash literal `/<name>` to recognise
// the command. The copy listener intercepts when the selection touches any pill
// and rewrites the `text/plain` clipboard payload accordingly.

const PILL_SELECTOR = "[data-cmd-mark], [data-type='skill']"

export function rewriteRangeForCommandCopy(range: Range): string {
  const fragment = range.cloneContents()
  const tmp = document.createElement("div")
  tmp.appendChild(fragment)
  tmp.querySelectorAll(PILL_SELECTOR).forEach((el) => {
    const name = (el as HTMLElement).dataset.name ?? ""
    el.replaceWith(document.createTextNode(`/${name}`))
  })
  tmp.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")))
  return tmp.textContent ?? ""
}

export function selectionTouchesCommandMark(editor: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.startContainer) && !editor.contains(range.endContainer)) {
    return false
  }
  const pills = editor.querySelectorAll(PILL_SELECTOR)
  for (const pill of pills) {
    if (range.intersectsNode(pill)) return true
  }
  return false
}
