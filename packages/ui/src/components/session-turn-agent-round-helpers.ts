import type { AssistantMessage } from "@opencode-ai/sdk/v2"

/**
 * Slice 11b.1 W1 agent-round pure helpers.
 *
 * Lives in a sibling .ts so the agent-round test suite can import these
 * deterministic functions without dragging the Solid + Kobalte tooltip
 * chain into a server-side test runner (Kobalte's client-only API
 * registry throws when its module is evaluated outside the browser).
 */

export function selectFirstAssistant(messages: readonly AssistantMessage[]): AssistantMessage | undefined {
  let best: AssistantMessage | undefined
  for (const message of messages) {
    const created = message.time?.created
    if (typeof created !== "number") continue
    if (!best || created < (best.time?.created ?? Number.POSITIVE_INFINITY)) {
      best = message
    }
  }
  return best
}

export function selectLatestAssistant(messages: readonly AssistantMessage[]): AssistantMessage | undefined {
  // The round's "latest" assistant: the still-running message if any,
  // otherwise the assistant with the largest `time.completed`.
  let running: AssistantMessage | undefined
  let bestCompleted: AssistantMessage | undefined
  for (const message of messages) {
    if (typeof message.time?.completed !== "number") {
      if (typeof message.time?.created === "number") {
        if (!running || (message.time.created ?? 0) > (running.time?.created ?? 0)) {
          running = message
        }
      }
      continue
    }
    if (!bestCompleted || (message.time.completed ?? 0) > (bestCompleted.time?.completed ?? 0)) {
      bestCompleted = message
    }
  }
  return running ?? bestCompleted
}

export function isInterrupted(messages: readonly AssistantMessage[]): boolean {
  const latest = selectLatestAssistant(messages)
  return latest?.error?.name === "MessageAbortedError"
}

export function computeElapsedSec(input: {
  startMs: number | undefined
  endMs: number | undefined
  nowMs: number
}): number {
  const { startMs, endMs, nowMs } = input
  if (typeof startMs !== "number") return 0
  const reference = typeof endMs === "number" ? endMs : nowMs
  return Math.max(0, Math.floor((reference - startMs) / 1000))
}
