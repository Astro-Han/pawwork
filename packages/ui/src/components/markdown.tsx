import { useMarked } from "../context/marked"
import { useI18n } from "../context/i18n"
import DOMPurify from "dompurify"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import { ComponentProps, createEffect, createResource, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"
import { stream } from "./markdown-stream"

type Entry = {
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, Entry>()

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
  // Allow only disabled checkbox inputs (GFM task list); strip every other
  // input variant that DOMPurify's html profile would otherwise pass through.
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "input") return
    if (!(node instanceof HTMLInputElement)) return
    const type = (node.getAttribute("type") ?? "").toLowerCase()
    if (type !== "checkbox") {
      node.parentNode?.removeChild(node)
      return
    }
    node.setAttribute("disabled", "")
  })
}

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["script", "iframe", "style", "form", "object", "embed"],
  FORBID_CONTENTS: ["script", "iframe", "style"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|file):|\/|\.{1,2}\/|#|[^:]*$)/i,
}

export const sanitizeConfig = config

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export const sanitizeForTest = sanitize


function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

type CopyLabels = {
  copy: string
  copied: string
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
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
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

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
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

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

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

export type LinkAction =
  | { kind: "external"; url: string }
  | { kind: "reveal"; path: string }
  | { kind: "anchor"; url: string }
  | { kind: "block" }

export function resolveLinkAction(href: string): LinkAction {
  const trimmed = href.trim()
  if (!trimmed) return { kind: "block" }
  if (trimmed.startsWith("#")) return { kind: "anchor", url: trimmed }
  // Protocol-relative URLs (//host/path) are remote-shaped — never reveal.
  if (trimmed.startsWith("//")) return { kind: "block" }
  if (/^https?:\/\//i.test(trimmed)) return { kind: "external", url: trimmed }
  if (/^mailto:/i.test(trimmed)) return { kind: "external", url: trimmed }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { kind: "block" }
  return { kind: "reveal", path: trimmed }
}

export type LinkActionHandlers = {
  openExternal?: (url: string) => void
  revealPath?: (path: string) => void
}

function setupLinkClicks(root: HTMLDivElement, handlers: LinkActionHandlers) {
  const handler = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest("a")
    if (!(anchor instanceof HTMLAnchorElement)) return
    if (anchor.closest('[data-slot="markdown-copy-button"]')) return
    const href = anchor.getAttribute("href") ?? ""
    const action = resolveLinkAction(href)
    event.preventDefault()
    if (action.kind === "block") return
    if (action.kind === "anchor") {
      const id = action.url.slice(1)
      if (!id) return
      const inner = root.querySelector(`#${CSS.escape(id)}`)
      if (inner instanceof HTMLElement) inner.scrollIntoView({ block: "start" })
      return
    }
    const desktop =
      typeof window !== "undefined"
        ? (window as unknown as {
            api?: {
              openLink?: (url: string) => void
              showItemInFolder?: (path: string) => unknown
            }
          }).api
        : undefined
    if (action.kind === "external") {
      if (handlers.openExternal) {
        handlers.openExternal(action.url)
      } else if (desktop?.openLink) {
        desktop.openLink(action.url)
      } else if (typeof window !== "undefined") {
        window.open(action.url, "_blank", "noopener,noreferrer")
      }
      return
    }
    if (action.kind === "reveal") {
      if (handlers.revealPath) {
        handlers.revealPath(action.path)
      } else if (desktop?.showItemInFolder) {
        void desktop.showItemInFolder(action.path)
      }
    }
  }
  // Capture phase so descendant stopPropagation cannot bypass routing.
  root.addEventListener("click", handler, true)
  return () => root.removeEventListener("click", handler, true)
}

function setupImageClicks(root: HTMLDivElement, openImage: (src: string) => void) {
  const handler = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof HTMLImageElement)) return
    const src = target.getAttribute("src") ?? ""
    if (!src) return
    event.preventDefault()
    openImage(src)
  }
  root.addEventListener("click", handler)
  return () => root.removeEventListener("click", handler)
}

const taskListIcons = {
  unchecked:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor"/>',
  checked:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor"/><path d="M5 8.2 7.2 10.4 11 6.4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
}

function rewriteTaskLists(root: ParentNode) {
  const inputs = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  )
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
    const wrapper = svg.parentElement
    if (wrapper && wrapper !== li && wrapper.tagName === "P") {
      li.insertBefore(svg, wrapper)
    }
    const next = svg.nextSibling
    if (next && next.nodeType === Node.TEXT_NODE && /^\s+/.test(next.textContent ?? "")) {
      next.textContent = (next.textContent ?? "").replace(/^\s+/, "")
    }
  }
}

export const rewriteTaskListsForTest = rewriteTaskLists

const chevSvg =
  '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function ensureDetailsChev(root: ParentNode) {
  const summaries = Array.from(root.querySelectorAll<HTMLElement>("details > summary"))
  for (const summary of summaries) {
    if (summary.querySelector("svg.chev")) continue
    const wrap = document.createElement("template")
    wrap.innerHTML = chevSvg
    const svg = wrap.content.firstElementChild
    if (svg) summary.insertBefore(svg, summary.firstChild)
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root)
  rewriteTaskLists(root)
  ensureDetailsChev(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
}

function touch(key: string, value: Entry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
    onLinkOpenExternal?: (url: string) => void
    onLinkRevealPath?: (path: string) => void
    onImageClick?: (src: string) => void
  },
) {
  const [local, others] = splitProps(props, [
    "text",
    "cacheKey",
    "streaming",
    "class",
    "classList",
    "onLinkOpenExternal",
    "onLinkRevealPath",
    "onImageClick",
  ])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [html] = createResource(
    () => ({
      text: local.text,
      key: local.cacheKey,
      streaming: local.streaming ?? false,
    }),
    async (src) => {
      if (isServer) return fallback(src.text)
      if (!src.text) return ""

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        stream(src.text, src.streaming).map(async (block, index) => {
          const hash = checksum(block.raw)
          const key = base ? `${base}:${index}:${block.mode}` : hash

          if (key && hash) {
            const cached = cache.get(key)
            if (cached && cached.hash === hash) {
              touch(key, cached)
              return cached.html
            }
          }

          const next = await Promise.resolve(marked.parse(block.src))
          const safe = sanitize(next)
          if (key && hash) touch(key, { hash, html: safe })
          return safe
        }),
      )
        .then((list) => list.join(""))
        .catch(() => fallback(src.text))
    },
    { initialValue: fallback(local.text) },
  )

  let copyCleanup: (() => void) | undefined
  let linkCleanup: (() => void) | undefined
  let imageCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const content = local.text ? (html.latest ?? html() ?? "") : ""
    if (!container) return
    if (isServer) return

    if (!content) {
      container.innerHTML = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const temp = document.createElement("div")
    temp.innerHTML = content
    decorate(temp, labels)

    morphdom(container, temp, {
      childrenOnly: true,
      onBeforeElUpdated: (fromEl, toEl) => {
        if (
          fromEl instanceof HTMLButtonElement &&
          toEl instanceof HTMLButtonElement &&
          fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
          toEl.getAttribute("data-slot") === "markdown-copy-button" &&
          fromEl.getAttribute("data-copied") === "true"
        ) {
          setCopyState(toEl, labels, true)
        }
        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
    })

    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
    if (!linkCleanup) {
      linkCleanup = setupLinkClicks(container, {
        openExternal: local.onLinkOpenExternal,
        revealPath: local.onLinkRevealPath,
      })
    }
    if (local.onImageClick && !imageCleanup) {
      imageCleanup = setupImageClicks(container, local.onImageClick)
    }
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    if (linkCleanup) linkCleanup()
    if (imageCleanup) imageCleanup()
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}
