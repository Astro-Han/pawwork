// Scoped copy handler logic for command pills.
//
// Browser default copy on a [data-cmd-mark] pill yields just the visible
// textContent (the label `<name>`, no slash). The rest of the system —
// Path C paste, command-line round-trip, cross-app paste — needs the slash
// literal `/<name>` to recognise the command. The copy listener intercepts
// when the selection touches any [data-cmd-mark] element and rewrites the
// `text/plain` clipboard payload accordingly.

/**
 * Walk a Range's cloned fragment and produce the text/plain string that
 * substitutes every [data-cmd-mark] with `/<dataset.name>` and every <br>
 * with `\n`. Returns the rewritten string.
 */
export function rewriteRangeForCommandCopy(range: Range): string {
  const fragment = range.cloneContents()
  const tmp = document.createElement("div")
  tmp.appendChild(fragment)
  tmp.querySelectorAll("[data-cmd-mark]").forEach((el) => {
    const name = (el as HTMLElement).dataset.name ?? ""
    el.replaceWith(document.createTextNode(`/${name}`))
  })
  tmp.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")))
  return tmp.textContent ?? ""
}

/**
 * Whether the current selection intersects any [data-cmd-mark] descendant of
 * `editor`. The listener should only intercept the copy event in this case;
 * otherwise the browser default applies (untouched by the command-copy logic).
 */
export function selectionTouchesCommandMark(editor: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.startContainer) && !editor.contains(range.endContainer)) {
    return false
  }
  const marks = editor.querySelectorAll("[data-cmd-mark]")
  for (const mark of marks) {
    if (range.intersectsNode(mark)) return true
  }
  return false
}
