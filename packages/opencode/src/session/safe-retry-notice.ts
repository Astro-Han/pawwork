import type { MessageV2 } from "./message-v2"
import { RunObservability } from "./run-observability"

/**
 * True when a side-effecting tool completed anywhere in the turn — possibly on a
 * sibling assistant message.
 *
 * #1358: the post-tool model continuation runs as a NEW assistant message (the
 * turn loop in prompt.ts creates one message per step), so a completed
 * side-effecting tool and the trailing `safe_retry_failed` notice land on
 * DIFFERENT messages of the same turn. The notice's own message therefore can't
 * be scanned for the tool — the whole turn must be. Only the backend can do this
 * reliably: the UI sees one part at a time and must not reclassify tools.
 *
 * "Side-effecting" is the backend's own classification (`toolEffect().unsafe`):
 * bash / apply_patch / unknown count; read-only tools (read/glob/grep/webfetch/
 * tool_info) do not. Unknown errs toward side-effecting so a real side effect is
 * never under-warned. Drives the "Action completed — don't repeat it" copy.
 */
export function turnHasCompletedSideEffect(
  messages: readonly MessageV2.WithParts[],
  parentID: NonNullable<MessageV2.Assistant["parentID"]>,
): boolean {
  return messages.some(
    (message) =>
      message.info.role === "assistant" &&
      message.info.parentID === parentID &&
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          part.state.status === "completed" &&
          RunObservability.toolEffect(part.tool).unsafe,
      ),
  )
}
