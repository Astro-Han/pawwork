export type CopyLabels = {
  copy: string
  copied: string
}

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

export function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
}

export function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    button.remove()
  }
}

export function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parent = code.parentElement
    if (parent instanceof HTMLAnchorElement && !parent.classList.contains("external-link")) continue
    const parentLink = parent instanceof HTMLAnchorElement ? parent : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

// Copy-button tooltip. A CSS ::after on the button gets clipped by the message
// stream's overflow:hidden when a code block sits near the stream's top or
// right edge. Instead one shared element lives on document.body with fixed
// positioning, so it escapes every ancestor's clipping and can be clamped into
// the viewport. Only one copy button is ever hovered or focused at a time, so a
// single element is enough.
let tooltipEl: HTMLDivElement | null = null
// WeakRef so a code block removed from the stream (chat re-render) can still be
// garbage-collected even while it is the last-hovered button.
let activeTooltipButton: WeakRef<HTMLButtonElement> | null = null

function getTooltipEl(): HTMLDivElement {
  if (tooltipEl?.isConnected) return tooltipEl
  const el = document.createElement("div")
  el.setAttribute("data-slot", "markdown-copy-tooltip")
  el.setAttribute("aria-hidden", "true")
  document.body.appendChild(el)
  tooltipEl = el
  return el
}

function showTooltip(button: HTMLButtonElement) {
  const label = button.getAttribute("data-tooltip")
  if (!label) return
  activeTooltipButton = new WeakRef(button)
  const tip = getTooltipEl()
  tip.textContent = label
  tip.setAttribute("data-show", "true")
  const anchor = button.getBoundingClientRect()
  const tip_box = tip.getBoundingClientRect()
  const gap = 4
  const margin = 4
  // Prefer above the button; flip below when there isn't room near the top.
  let top = anchor.top - tip_box.height - gap
  if (top < margin) top = anchor.bottom + gap
  // Center on the button, then clamp so neither edge leaves the viewport.
  let left = anchor.left + anchor.width / 2 - tip_box.width / 2
  const maxLeft = window.innerWidth - tip_box.width - margin
  left = Math.max(margin, Math.min(left, maxLeft))
  tip.style.top = `${Math.round(top)}px`
  tip.style.left = `${Math.round(left)}px`
}

function hideTooltip(button?: HTMLButtonElement) {
  // Early-out avoids redundant DOM writes on scroll/resize when nothing shows.
  if (!activeTooltipButton) return
  if (button && activeTooltipButton.deref() !== button) return
  activeTooltipButton = null
  tooltipEl?.removeAttribute("data-show")
}

// A fixed tooltip would drift away from its button when the page scrolls or
// resizes, so we dismiss it. The tooltip is a single shared element, so these
// global listeners are reference-counted and registered once for the whole app
// rather than once per Markdown instance.
let viewportDismissCount = 0
function dismissOnViewportChange() {
  hideTooltip()
}
function retainViewportDismiss() {
  if (viewportDismissCount === 0) {
    window.addEventListener("scroll", dismissOnViewportChange, true)
    window.addEventListener("resize", dismissOnViewportChange)
  }
  viewportDismissCount++
}
function releaseViewportDismiss() {
  viewportDismissCount = Math.max(0, viewportDismissCount - 1)
  if (viewportDismissCount === 0) {
    window.removeEventListener("scroll", dismissOnViewportChange, true)
    window.removeEventListener("resize", dismissOnViewportChange)
  }
}

export function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const buttonFromEvent = (target: EventTarget | null) =>
    target instanceof Element ? target.closest('[data-slot="markdown-copy-button"]') : null

  const handleClick = async (event: MouseEvent) => {
    const button = buttonFromEvent(event.target)
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    try {
      await clipboard.writeText(content)
      setCopyState(button, getLabels(), true)
      showTooltip(button)
      const existing = timeouts.get(button)
      if (existing) clearTimeout(existing)
      const timeout = setTimeout(() => {
        setCopyState(button, getLabels(), false)
        if (activeTooltipButton?.deref() === button) {
          // Keep the tooltip while the button is still hovered OR keyboard-
          // focused; a keyboard copy leaves focus on the button, not hover.
          if (button.matches(":hover") || document.activeElement === button) showTooltip(button)
          else hideTooltip(button)
        }
        timeouts.delete(button)
      }, 2000)
      timeouts.set(button, timeout)
    } catch (err) {
      console.error("Clipboard copy failed", err)
    }
  }

  const handlePointerOver = (event: MouseEvent) => {
    const button = buttonFromEvent(event.target)
    if (button instanceof HTMLButtonElement) showTooltip(button)
  }
  const handlePointerOut = (event: MouseEvent) => {
    const button = buttonFromEvent(event.target)
    if (!(button instanceof HTMLButtonElement)) return
    // Moving between the button and its child icon should not dismiss it.
    const next = event.relatedTarget
    if (next instanceof Node && button.contains(next)) return
    hideTooltip(button)
  }
  const handleFocusIn = (event: FocusEvent) => {
    const button = buttonFromEvent(event.target)
    if (button instanceof HTMLButtonElement) showTooltip(button)
  }
  const handleFocusOut = (event: FocusEvent) => {
    const button = buttonFromEvent(event.target)
    if (button instanceof HTMLButtonElement) hideTooltip(button)
  }
  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  // Markdown updates content via morphdom or innerHTML = "", neither of which
  // fires a mouse/focus event; watch the subtree so a tooltip whose button was
  // removed (chat re-render, content cleared) is dismissed, not left on screen.
  const detachObserver = new MutationObserver(() => {
    const active = activeTooltipButton?.deref()
    if (active && !active.isConnected) hideTooltip()
  })
  detachObserver.observe(root, { childList: true, subtree: true })

  root.addEventListener("click", handleClick)
  root.addEventListener("mouseover", handlePointerOver)
  root.addEventListener("mouseout", handlePointerOut)
  root.addEventListener("focusin", handleFocusIn)
  root.addEventListener("focusout", handleFocusOut)
  retainViewportDismiss()

  return () => {
    root.removeEventListener("click", handleClick)
    root.removeEventListener("mouseover", handlePointerOver)
    root.removeEventListener("mouseout", handlePointerOut)
    root.removeEventListener("focusin", handleFocusIn)
    root.removeEventListener("focusout", handleFocusOut)
    releaseViewportDismiss()
    detachObserver.disconnect()
    const activeBtn = activeTooltipButton?.deref()
    if (activeBtn && root.contains(activeBtn)) hideTooltip()
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
}
