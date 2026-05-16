const taskListIcons = {
  unchecked: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor"/>',
  checked:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor"/><path d="M5 8.2 7.2 10.4 11 6.4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
}

export function rewriteTaskLists(root: ParentNode) {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
  for (const input of inputs) {
    const li = input.closest("li")
    if (!(li instanceof HTMLLIElement)) continue
    li.classList.add("task-item")
    const checked = input.hasAttribute("checked")
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 16 16")
    svg.setAttribute("aria-hidden", "true")
    svg.setAttribute("data-state", checked ? "checked" : "unchecked")
    svg.innerHTML = checked ? taskListIcons.checked : taskListIcons.unchecked
    input.replaceWith(svg)
    // marked may wrap the checkbox in <p> for loose lists. Hoist the svg up
    // so the LI flexbox aligns icon and label in one row.
    const pWrap = svg.parentElement
    if (pWrap && pWrap !== li && pWrap.tagName === "P") {
      li.insertBefore(svg, pWrap)
    }
    // Group everything after the svg into a label wrapper. Without this,
    // nested <ul> or <p> blocks in loose task items become flex siblings
    // of the icon and render to its right instead of below the label.
    const label = document.createElement("span")
    label.dataset.slot = "task-label"
    let post = svg.nextSibling
    while (post) {
      const nextPost = post.nextSibling
      label.appendChild(post)
      post = nextPost
    }
    li.appendChild(label)
    // Strip leading whitespace surrounding the original `<input> text`.
    // After hoist+wrap the leading text sits either directly inside the
    // label (tight list) or inside its first element child (loose list).
    const stripLeading = (node: Node | null | undefined) => {
      if (node?.nodeType === Node.TEXT_NODE && /^\s+/.test(node.textContent ?? "")) {
        node.textContent = (node.textContent ?? "").replace(/^\s+/, "")
      }
    }
    const first = label.firstChild
    stripLeading(first)
    if (first?.nodeType === Node.ELEMENT_NODE) {
      stripLeading((first as Element).firstChild)
    }
  }
}

export const rewriteTaskListsForTest = rewriteTaskLists
