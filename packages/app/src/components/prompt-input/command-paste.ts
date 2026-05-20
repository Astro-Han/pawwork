// Pure data-transform for Path C: paste of `/<known-name> <args>` into a
// structurally-empty input produces a marked TextPart. Any non-empty existing
// state (text, attachments, context items) declines — paste falls back to
// the default text-insert path.
//
// Path C runs against the RAW clipboard text, NOT normalizePaste output —
// normalizePaste strips trailing whitespace and collapses runs of blank lines,
// which would change command-boundary semantics. The command regex needs
// verbatim clipboard content.

import type {
  ContextItem,
  ImageAttachmentPart,
  Prompt,
} from "@/context/prompt"
import { isStructurallyEmpty } from "@/context/prompt"
import type { CommandDescriptor } from "./command-text-part"
import { tryParseLeadingCommandFromText } from "./command-text-part"

export interface PathCInput {
  plainText: string
  currentPrompt: Prompt
  contextItems: readonly ContextItem[]
  imageAttachments: readonly ImageAttachmentPart[]
  registry: ReadonlyArray<CommandDescriptor>
  composing: boolean
}

/**
 * Try to convert a paste into a marked TextPart. Returns the new Prompt on
 * conversion, or null when Path C declines (any guard fails: IME composing,
 * not structurally empty, regex miss, or registry miss).
 */
export function tryPathCConversion(input: PathCInput): Prompt | null {
  if (input.composing) return null
  if (!isStructurallyEmpty(input.currentPrompt, input.contextItems, input.imageAttachments)) {
    return null
  }
  const marked = tryParseLeadingCommandFromText(input.plainText, input.registry)
  if (!marked) return null
  return [marked]
}
