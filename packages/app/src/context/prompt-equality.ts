// Pure prompt-equality and default-prompt helpers, split out of prompt.tsx so
// they can be imported without loading the prompt context provider (which pulls
// in @solidjs/router, a client-only module that throws when evaluated in bun's
// server-side test env). Runtime imports here must stay empty / type-only.

import type { FileSelection } from "@/context/file"
import type { ContentPart, ContextItem, ImageAttachmentPart, Prompt, TextPart } from "./prompt"

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isCommandMetaEqual(a: TextPart["command"], b: TextPart["command"]) {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.name === b.name && a.source === b.source && a.icon === b.icon
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return (
        partB.type === "text" &&
        partA.content === partB.content &&
        isCommandMetaEqual(partA.command, partB.command)
      )
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

export function isStructurallyEmpty(
  prompt: Prompt,
  contextItems: readonly ContextItem[],
  imageAttachments: readonly ImageAttachmentPart[],
): boolean {
  if (contextItems.length > 0) return false
  if (imageAttachments.length > 0) return false
  return isPromptEqual(prompt, DEFAULT_PROMPT)
}
