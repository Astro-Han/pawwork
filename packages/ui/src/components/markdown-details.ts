/**
 * Force every <details> element open by default.
 *
 * Why: in chat output, an LLM emitting `<details>` is grouping related
 * content (extended explanation, code example, expanded discussion), not
 * hiding low-value reasoning. Auto-collapsing on stream completion would
 * make the user re-click to see what they just saw stream in. Default-open
 * also sidesteps marked's HTML-block parser instability on partial input
 * (without `</details>` closed, code fences can briefly parse outside the
 * subtree, making content "jump out" of a closed block).
 *
 * Pairs with `preserveDetailsOpenState` in the morphdom diff: this helper
 * makes the initial state open; that one preserves the user's manual
 * collapse across subsequent diffs.
 */
export function forceOpenAllDetails(root: ParentNode): void {
  for (const d of root.querySelectorAll<HTMLDetailsElement>("details")) {
    d.setAttribute("open", "")
  }
}

/**
 * Preserve the user's <details> open state across morphdom diffs.
 * After the user manually collapses a default-open details block, every
 * subsequent re-render must keep it collapsed (otherwise i18n changes or
 * other re-render triggers would flip it back to open via `forceOpenAllDetails`).
 */
export function preserveDetailsOpenState(fromEl: Element, toEl: Element): void {
  if (fromEl instanceof HTMLDetailsElement && toEl instanceof HTMLDetailsElement) {
    if (fromEl.hasAttribute("open")) toEl.setAttribute("open", "")
    else toEl.removeAttribute("open")
  }
}

const chevSvg =
  '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export function ensureDetailsChev(root: ParentNode) {
  const summaries = Array.from(root.querySelectorAll<HTMLElement>("details > summary"))
  for (const summary of summaries) {
    if (summary.querySelector("svg.chev")) continue
    const wrap = document.createElement("template")
    wrap.innerHTML = chevSvg
    const svg = wrap.content.firstElementChild
    if (svg) summary.insertBefore(svg, summary.firstChild)
  }
}
