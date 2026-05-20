// Pure data-transform for the Backspace fallback ladder on a command-marked
// leading TextPart. No DOM, no reactive context.
//
// The three cases (in order, first match wins):
//   1. Marked content has args (length > prefix.length): strip "/<name> ", drop
//      command metadata. Result: [Text(argsOnly), ...rest]. Caret at 0.
//   2. Marked content is exactly "/<name> " AND rest.length > 0: remove only
//      the marked TextPart. Result: [...rest]. Caret at 0.
//   3. Marked content is exactly "/<name> " AND no rest: collapse to DEFAULT_PROMPT.

import type { Prompt, TextPart } from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt"

/**
 * Compute the new Prompt after a Backspace that fires the command fallback
 * ladder. Returns a fresh array; the caller must pass it to `prompt.set`.
 *
 * @param parts - prompt.current() snapshot at the moment Backspace fires
 * @param first - parts[0] cast to a marked TextPart (caller must verify)
 * @param prefix - `"/${first.command.name} "` (passed in to avoid recomputation)
 */
export function computeCommandBackspaceResult(
  parts: Prompt,
  first: TextPart & { command: NonNullable<TextPart["command"]> },
  prefix: string,
): Prompt {
  const rest = parts.slice(1)
  const argsAfterPrefix = first.content.slice(prefix.length)

  if (argsAfterPrefix.length > 0) {
    // Case 1: strip prefix, drop command metadata.
    const newFirst: TextPart = {
      type: "text",
      content: argsAfterPrefix,
      start: 0,
      end: argsAfterPrefix.length,
    }
    return [newFirst, ...rest]
  }

  // No args (content === "/<name> ").
  if (rest.length > 0) {
    // Case 2: remove only the marked TextPart.
    return rest
  }

  // Case 3: sole part — collapse to DEFAULT_PROMPT.
  return DEFAULT_PROMPT
}
