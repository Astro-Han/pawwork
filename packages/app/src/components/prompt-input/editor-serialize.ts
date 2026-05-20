// DOM ↔ Parts bidirectional serialization for the contenteditable composer.
// Pure functions, no Solid reactivity. Pairs with editor-dom (cursor primitives).

import {
  type AgentPart,
  type CommandSource,
  type FileAttachmentPart,
  type TextPart,
  type Prompt,
  DEFAULT_PROMPT,
} from "@/context/prompt"
import { resolveCommandIconSvg } from "@opencode-ai/ui/command-icon"
import { createTextFragment } from "./editor-dom"
import "./command-pill.css"

/** Build the DOM node for a slash-command pill (contenteditable=false). */
export function createCommandMark(part: TextPart & { command: NonNullable<TextPart["command"]> }): HTMLSpanElement {
  const cmd = part.command
  const outer = document.createElement("span")
  outer.setAttribute("data-cmd-mark", "true")
  outer.setAttribute("data-name", cmd.name)
  outer.setAttribute("data-source", cmd.source)
  outer.setAttribute("data-icon", cmd.icon)
  outer.setAttribute("contenteditable", "false")

  // Icon child — SVG injected via innerHTML; aria-hidden so screen-readers skip it
  const iconSpan = document.createElement("span")
  iconSpan.setAttribute("data-cmd-icon", "true")
  iconSpan.setAttribute("aria-hidden", "true")
  iconSpan.className = "command-icon"
  iconSpan.innerHTML = resolveCommandIconSvg(cmd.icon)
  outer.appendChild(iconSpan)

  // Label child — name without slash, visible text
  const labelSpan = document.createElement("span")
  labelSpan.setAttribute("data-cmd-label", "true")
  labelSpan.textContent = cmd.name
  outer.appendChild(labelSpan)

  return outer
}

export function createPill(part: FileAttachmentPart | AgentPart): HTMLSpanElement {
  const pill = document.createElement("span")
  pill.textContent = part.content
  pill.setAttribute("data-type", part.type)
  if (part.type === "file") pill.setAttribute("data-path", part.path)
  if (part.type === "agent") pill.setAttribute("data-name", part.name)
  pill.setAttribute("contenteditable", "false")
  pill.style.userSelect = "text"
  pill.style.cursor = "default"
  return pill
}

export function isNormalizedEditor(editor: HTMLElement): boolean {
  return Array.from(editor.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ""
      if (!text.includes("\u200B")) return true
      if (text !== "\u200B") return false

      const prev = node.previousSibling
      const next = node.nextSibling
      const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
      return !!prevIsBr && !next
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const el = node as HTMLElement
    if (el.dataset.type === "file") return true
    if (el.dataset.type === "agent") return true
    // Command pill at index 0 is a normal expected child; without this the
    // reconcile pass forces a full DOM rebuild on every keystroke after a pill
    // exists, which moves the caret and breaks IME / selections.
    if (el.dataset.cmdMark === "true") return true
    return el.tagName === "BR"
  })
}

export function renderPartsToEditor(editor: HTMLElement, parts: Prompt): void {
  editor.replaceChildren()
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === "text") {
      // Leading text part with command metadata: render pill + tail separately.
      // Only index 0 gets the pill treatment; subsequent text parts are plain.
      if (i === 0 && part.command) {
        const cmd = part.command
        const pillPart = part as TextPart & { command: NonNullable<TextPart["command"]> }
        // The content is "/<name><sep><args>" — strip the "/<name>" prefix so
        // only the separator + args remain in the text fragment after the pill.
        const prefixLen = 1 + cmd.name.length // slash + name
        const tail = part.content.slice(prefixLen)
        editor.appendChild(createCommandMark(pillPart))
        if (tail) editor.appendChild(createTextFragment(tail))
        continue
      }
      editor.appendChild(createTextFragment(part.content))
      continue
    }
    if (part.type === "file" || part.type === "agent") {
      editor.appendChild(createPill(part))
    }
  }

  const last = editor.lastChild
  if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
    editor.appendChild(document.createTextNode("\u200B"))
  }
}

export function parseEditorToParts(editor: HTMLElement): Prompt {
  const parts: Prompt = []
  let position = 0
  let buffer = ""

  const flushText = () => {
    let content = buffer
    if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
    if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
    buffer = ""
    if (!content) return
    parts.push({ type: "text", content, start: position, end: position + content.length })
    position += content.length
  }

  const pushFile = (file: HTMLElement) => {
    const content = file.textContent ?? ""
    parts.push({
      type: "file",
      path: file.dataset.path!,
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushAgent = (agent: HTMLElement) => {
    const content = agent.textContent ?? ""
    parts.push({
      type: "agent",
      name: agent.dataset.name!,
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as HTMLElement
    if (el.dataset.type === "file") {
      flushText()
      pushFile(el)
      return
    }
    if (el.dataset.type === "agent") {
      flushText()
      pushAgent(el)
      return
    }
    if (el.tagName === "BR") {
      buffer += "\n"
      return
    }

    for (const child of Array.from(el.childNodes)) {
      visit(child)
    }
  }

  const children = Array.from(editor.childNodes)

  // Leading-pill branch: if the very first child is a data-cmd-mark element,
  // reconstruct the marked TextPart (Parser reconstruction rule, spec L538-546).
  // content = "/" + dataset.name + followingTextRun, where followingTextRun is
  // the verbatim concat of text/BR nodes immediately after the pill until next
  // pill/file/agent/end.
  let startIndex = 0
  const firstChild = children[0]
  if (
    firstChild?.nodeType === Node.ELEMENT_NODE &&
    (firstChild as HTMLElement).dataset.cmdMark === "true"
  ) {
    const pillEl = firstChild as HTMLElement
    const name = pillEl.dataset.name ?? ""
    const source = (pillEl.dataset.source ?? "skill") as CommandSource
    const icon = pillEl.dataset.icon ?? "command"

    // Collect following text run siblings (stop at next pill/file/agent boundary)
    let followingTextRun = ""
    let consumedSiblings = 0
    for (let si = 1; si < children.length; si++) {
      const sibling = children[si]!
      if (sibling.nodeType === Node.TEXT_NODE) {
        followingTextRun += sibling.textContent ?? ""
        consumedSiblings++
      } else if (sibling.nodeType === Node.ELEMENT_NODE) {
        const sibEl = sibling as HTMLElement
        // Stop at any pill-like boundary
        if (sibEl.tagName === "BR") {
          followingTextRun += "\n"
          consumedSiblings++
        } else if (sibEl.dataset.type === "file" || sibEl.dataset.type === "agent" || sibEl.dataset.cmdMark === "true") {
          break
        } else {
          // Unknown inline element — recurse and collect text
          followingTextRun += sibEl.textContent ?? ""
          consumedSiblings++
        }
      } else {
        break
      }
    }

    // Strip zero-width space from collected run
    followingTextRun = followingTextRun.replace(/​/g, "")

    const content = "/" + name + followingTextRun
    const cmdPart: TextPart = {
      type: "text",
      content,
      start: position,
      end: position + content.length,
      command: { name, source, icon },
    }
    parts.push(cmdPart)
    position += content.length

    // Skip the pill + consumed siblings in the main loop below
    startIndex = 1 + consumedSiblings
  }

  children.slice(startIndex).forEach((child, relIndex) => {
    const index = startIndex + relIndex
    const isBlock =
      child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
    visit(child)
    // Skip the block separator if the block already contributed a trailing
    // newline (e.g. an empty <div><br></div>): otherwise round-tripping a
    // blank row inflates "foo\n\nbar" into "foo\n\n\nbar".
    if (isBlock && index < children.length - 1 && !buffer.endsWith("\n")) {
      buffer += "\n"
    }
  })

  flushText()

  if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
  return parts
}
