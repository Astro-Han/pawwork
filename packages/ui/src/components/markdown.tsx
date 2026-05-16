import { useMarked } from "../context/marked"
import { useI18n } from "../context/i18n"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import { ComponentProps, createEffect, createResource, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"
import { stream } from "./markdown-stream"
import { ensureCodeWrapper, markCodeLinks, setCopyState, setupCodeCopy, type CopyLabels } from "./markdown-code-tools"
import { ensureDetailsChev, forceOpenAllDetails, preserveDetailsOpenState } from "./markdown-details"
import { setupImageClicks, setupLinkClicks } from "./markdown-link-routing"
import { fallbackMarkdownHtml, sanitizeMarkdownHtml } from "./markdown-sanitize"
import { rewriteTaskLists } from "./markdown-task-list"

export { forceOpenAllDetails, preserveDetailsOpenState } from "./markdown-details"
export { resolveLinkAction, type LinkAction, type LinkActionHandlers } from "./markdown-link-routing"
export { sanitizeConfig, sanitizeForTest } from "./markdown-sanitize"
export { rewriteTaskListsForTest } from "./markdown-task-list"

type Entry = {
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, Entry>()

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root)
  rewriteTaskLists(root)
  ensureDetailsChev(root)
  forceOpenAllDetails(root)
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
      if (isServer) return fallbackMarkdownHtml(src.text)
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
          const safe = sanitizeMarkdownHtml(next)
          if (key && hash) touch(key, { hash, html: safe })
          return safe
        }),
      )
        .then((list) => list.join(""))
        .catch(() => fallbackMarkdownHtml(src.text))
    },
    { initialValue: fallbackMarkdownHtml(local.text) },
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
      copy: i18n.t("ui.textField.copyToClipboard"),
      copied: i18n.t("ui.textField.copied"),
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
        preserveDetailsOpenState(fromEl, toEl)
        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
    })

    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.textField.copyToClipboard"),
        copied: i18n.t("ui.textField.copied"),
      }))
    if (!linkCleanup) {
      linkCleanup = setupLinkClicks(container, {
        openExternal: (url) => local.onLinkOpenExternal?.(url),
        revealPath: (path) => local.onLinkRevealPath?.(path),
      })
    }
    if (local.onImageClick && !imageCleanup) {
      imageCleanup = setupImageClicks(container, (src) => local.onImageClick?.(src))
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
      data-image-click={local.onImageClick ? "" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}
