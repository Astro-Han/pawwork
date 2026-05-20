// Pure data-transform: prepend a marked TextPart to a Prompt on slash-command
// select. No DOM, no reactive context.
//
// Two cases:
//   1. Empty prompt (equal to DEFAULT_PROMPT) with optional image attachments:
//      result is [marked, ...images].
//   2. Non-empty prompt: result is [marked, ...current].
//
// Non-text part identity (FilePart / AgentPart / ImagePart references) is
// preserved exactly — no cloning of incoming parts.

import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { DEFAULT_PROMPT, isPromptEqual } from "@/context/prompt"
import { createCommandTextPart, type CommandDescriptor } from "./command-text-part"

/**
 * Build the new Prompt after the user selects a custom slash command.
 *
 * @param current - snapshot of prompt.current() at the moment of selection
 * @param images  - imageAttachments() at the moment of selection
 * @param cmd     - descriptor forwarded from the SlashCommand entry
 * @returns new Prompt with the marked TextPart prepended; cursor target is
 *          `result[0].content.length` (end of the pill text)
 */
export function prependCommandMark(
  current: Prompt,
  images: ImageAttachmentPart[],
  cmd: CommandDescriptor,
): Prompt {
  const marked = createCommandTextPart(cmd, "")
  const isEmpty = isPromptEqual(current, DEFAULT_PROMPT)

  if (isEmpty) {
    // Preserve image attachment identity; omit the bare empty TextPart.
    return [marked, ...images]
  }

  // E1 variant: keep all existing parts (including any images already inside
  // current) in original order and identity.
  return [marked, ...current]
}
