import DOMPurify from "dompurify"

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["script", "iframe", "style", "form", "object", "embed"],
  FORBID_CONTENTS: ["script", "iframe", "style"],
  ALLOWED_URI_REGEXP: /^(?!\/\/)(?:(?:https?|mailto|file):|\/|\.{1,2}\/|#|[^:]*$)/i,
}

export const sanitizeConfig = config

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

export function sanitizeMarkdownHtml(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export const sanitizeForTest = sanitizeMarkdownHtml

function escapeMarkdownText(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function fallbackMarkdownHtml(markdown: string) {
  return escapeMarkdownText(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}
