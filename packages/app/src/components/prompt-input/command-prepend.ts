// Pure data-transform: build the new Prompt after the user selects a slash
// command from the popover. Three cases:
//
//   1. Empty prompt (DEFAULT_PROMPT) with optional image attachments:
//      result is [marked, ...images].
//   2. Slash-query state — the user opened the popover by typing /<query>;
//      current is a single plain TextPart whose content matches `^/(\S*)$`.
//      Per spec §Path A step 4, replace the entire slash-query match with
//      the marked TextPart. Result: [marked, ...images].
//   3. E1 mid-prompt — the popover was opened via the global command.trigger
//      keybind while the editor already had unrelated content. Result:
//      [marked, ...current], preserving original parts in order and identity.
//
// Non-text part identity (FilePart / AgentPart / ImagePart references) is
// preserved exactly — no cloning of incoming parts.

import type { ImageAttachmentPart, Prompt, TextPart } from "@/context/prompt"
import { DEFAULT_PROMPT, isPromptEqual } from "@/context/prompt"
import { createCommandTextPart, type CommandDescriptor } from "./command-text-part"

// Slash trigger regex — must match `editor-input.ts:261` exactly so the
// "popover was opened by slash typing" detection here mirrors what opened it.
const SLASH_QUERY_REGEX = /^\/(\S*)$/

function isSlashQueryState(current: Prompt): boolean {
  if (current.length !== 1) return false
  const first = current[0] as TextPart
  if (first.type !== "text") return false
  if (first.command) return false // already a marked TextPart — not a query
  return SLASH_QUERY_REGEX.test(first.content)
}

function hasLeadingMarked(current: Prompt): boolean {
  const first = current[0]
  return first?.type === "text" && !!first.command
}

// Extract the args portion from a leading marked TextPart. content always
// starts with "/<name> " per createCommandTextPart's invariant, so slicing
// off that prefix yields the user-typed args (possibly empty).
function leadingArgs(current: Prompt): string {
  const first = current[0] as TextPart & { command: NonNullable<TextPart["command"]> }
  const prefix = `/${first.command.name} `
  return first.content.slice(prefix.length)
}

/**
 * Build the new Prompt after the user selects a custom slash command.
 *
 * @param current - snapshot of prompt.current() at the moment of selection
 * @param images  - imageAttachments() at the moment of selection
 * @param cmd     - descriptor forwarded from the SlashCommand entry
 * @returns new Prompt; cursor target is `result[0].content.length` (end of
 *          the pill text, which is `/<name> ` per createCommandTextPart's
 *          trailing-space invariant)
 */
export function prependCommandMark(
  current: Prompt,
  images: ImageAttachmentPart[],
  cmd: CommandDescriptor,
): Prompt {
  const marked = createCommandTextPart(cmd, "")

  if (isPromptEqual(current, DEFAULT_PROMPT) || isSlashQueryState(current)) {
    // Empty prompt OR slash-query state — replace the editor content with the
    // marked TextPart. The slash literal the user typed (`/foo`) is consumed
    // by the conversion. Image attachments survive.
    return [marked, ...images]
  }

  if (hasLeadingMarked(current)) {
    // Invariant: at most one marked TextPart per Prompt, always at index 0.
    // Re-opening the popover and picking a second command means the user is
    // changing their mind about the command name — swap the pill but keep
    // the args the user already typed. $ARGUMENTS is a plain string
    // substitution with no schema, so any text the user kept is still
    // legitimate input for the new command; deciding otherwise would mean
    // the system silently deletes work the user invested time in. If the
    // args do not fit the new command, the user can see them in the editor
    // and remove them. Tail parts (files, agents, images) survive by
    // identity.
    const carriedArgs = leadingArgs(current)
    const markedWithArgs = createCommandTextPart(cmd, carriedArgs)
    return [markedWithArgs, ...current.slice(1)]
  }

  // E1 mid-prompt variant: keep all existing parts (including any images
  // already inside current) in original order and identity.
  return [marked, ...current]
}
