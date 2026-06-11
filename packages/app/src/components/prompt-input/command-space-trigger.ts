// Pure data-transform for Path B: detect whether a Space-keystroke just typed
// at the end of `/<known-name>` should materialise into a pill.
//
// Browser fires `input` events with `inputType === "insertText"` exclusively
// when the user types a single character. This is naturally false on paste
// (`insertFromPaste`), Backspace (`deleteContentBackward`), IME commit
// (`insertCompositionText`), and programmatic mutations (no event). No flag
// state machine needed.

import type { FloatingAttachment, Prompt } from "@/context/prompt"
import type { CommandDescriptor } from "./command-text-part"
import { tryParseLeadingCommandFromText } from "./command-text-part"

// Anchored Path B buffer check: leading slash, captured non-whitespace name,
// exactly one trailing space, end of string. A space typed mid-args (buffer
// like "/cmd args ") does NOT match — the args section already contains
// whitespace, so `\S+` cannot bridge it.
const SPACE_TRIGGER_REGEX = /^\/(\S+) $/

export interface SpaceTriggerInput {
  inputType?: string | null
  data?: string | null
  rawText: string
  images: FloatingAttachment[]
  registry: ReadonlyArray<CommandDescriptor>
}

/**
 * Try to convert a Space-keystroke at `/<known-name>` into a marked TextPart.
 * Returns the new Prompt and target cursor position on conversion, or null
 * when Path B declines (event shape wrong, buffer shape wrong, or registry miss).
 */
export function tryPathBConversion(
  input: SpaceTriggerInput,
): { prompt: Prompt; cursor: number } | null {
  if (input.inputType !== "insertText") return null
  if (input.data !== " ") return null
  if (!SPACE_TRIGGER_REGEX.test(input.rawText)) return null
  const marked = tryParseLeadingCommandFromText(input.rawText, input.registry)
  if (!marked) return null
  return {
    prompt: [marked, ...input.images],
    cursor: marked.content.length,
  }
}
