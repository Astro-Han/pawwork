import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2/client"

export type CompactionDividerState = "pending" | "done" | "aborted" | "failed"

export type CompactionDividerLabel =
  | { key: "ui.messagePart.compaction.pending" }
  | { key: "ui.messagePart.compaction" }
  | { key: "ui.messagePart.compaction.aborted" }
  | { key: "ui.messagePart.compaction.failed"; params: { reason: string } }
  | { key: "ui.messagePart.compaction.failedUnknown" }
  | { key: "ui.messagePart.compaction.failedContextOverflow" }

// Order matters: processor.cleanup() writes `time.completed` on abort/error
// paths too, so checking `time.completed` first would misclassify
// aborted/failed as `done`. Match in this exact order.
export function compactionDividerState(input: {
  summaryAssistant: AssistantMessage | undefined
}): CompactionDividerState {
  const summary = input.summaryAssistant
  if (!summary) return "pending"
  if (summary.error?.name === "MessageAbortedError") return "aborted"
  if (summary.error) return "failed"
  if (typeof summary.time.completed === "number") return "done"
  return "pending"
}

export function compactionDividerLabelKey(input: {
  state: CompactionDividerState
  // NamedError.toObject() shape: { name, data: { message, ... } }. The
  // top-level `message` was an early helper-only shape that never matches
  // real assistant errors — kept as a fallback so unit tests with synthetic
  // shapes don't have to wrap everything in `data`.
  error?: { name?: string; message?: string; data?: { message?: string } & Record<string, unknown> } | null
}): CompactionDividerLabel {
  switch (input.state) {
    case "pending":
      return { key: "ui.messagePart.compaction.pending" }
    case "done":
      return { key: "ui.messagePart.compaction" }
    case "aborted":
      return { key: "ui.messagePart.compaction.aborted" }
    case "failed": {
      const name = input.error?.name
      if (name === "ContextOverflowError") {
        return { key: "ui.messagePart.compaction.failedContextOverflow" }
      }
      const reason = (input.error?.data?.message ?? input.error?.message ?? "").trim()
      // Some NamedError variants (e.g. MessageOutputLengthError) carry empty
      // `data`, so reason is "". The default template "Compaction failed: {{reason}}"
      // would render with a trailing colon — drop to a no-colon variant.
      if (!reason) return { key: "ui.messagePart.compaction.failedUnknown" }
      return { key: "ui.messagePart.compaction.failed", params: { reason } }
    }
  }
}

export function compactionElapsedSeconds(input: {
  state: CompactionDividerState
  summaryAssistant: AssistantMessage | undefined
  compactionUserMessage: UserMessage
  now: number
}): number {
  if (input.state !== "pending") return 0
  const start = input.summaryAssistant?.time.created ?? input.compactionUserMessage.time.created
  if (typeof start !== "number") return 0
  const seconds = Math.floor((input.now - start) / 1000)
  return seconds < 0 ? 0 : seconds
}

export function formatCompactionElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m ${remainder}s`
}
