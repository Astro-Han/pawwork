import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2/client"
import {
  compactionDividerLabelKey,
  compactionDividerState,
  compactionElapsedSeconds,
  formatCompactionElapsed,
} from "./session-turn-compaction"

function user(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: "u1",
    sessionID: "s1",
    role: "user",
    time: { created: 10_000 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    ...overrides,
  } as UserMessage
}

function summary(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "a1",
    sessionID: "s1",
    role: "assistant",
    parentID: "u1",
    mode: "compaction",
    agent: "compaction",
    summary: true,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "claude-opus-4-7",
    providerID: "anthropic",
    time: { created: 11_000 },
    ...overrides,
  } as AssistantMessage
}

describe("compactionDividerState", () => {
  test("no summary assistant → pending (race window)", () => {
    expect(compactionDividerState({ summaryAssistant: undefined })).toBe("pending")
  })

  test("abort error → aborted (even when time.completed is set)", () => {
    const s = summary({
      error: { name: "MessageAbortedError", data: { message: "abort" } },
      time: { created: 11_000, completed: 12_000 },
    })
    expect(compactionDividerState({ summaryAssistant: s })).toBe("aborted")
  })

  test("non-abort error → failed (even when time.completed is set)", () => {
    const s = summary({
      error: { name: "APIError", data: { message: "boom", isRetryable: false } },
      time: { created: 11_000, completed: 12_000 },
    })
    expect(compactionDividerState({ summaryAssistant: s })).toBe("failed")
  })

  test("time.completed set without error → done", () => {
    const s = summary({ time: { created: 11_000, completed: 12_000 } })
    expect(compactionDividerState({ summaryAssistant: s })).toBe("done")
  })

  test("summary streaming (no completed, no error) → pending", () => {
    const s = summary({ time: { created: 11_000 } })
    expect(compactionDividerState({ summaryAssistant: s })).toBe("pending")
  })
})

describe("compactionDividerLabelKey", () => {
  test("pending returns pending key", () => {
    expect(compactionDividerLabelKey({ state: "pending" })).toEqual({
      key: "ui.messagePart.compaction.pending",
    })
  })

  test("done returns the existing done key", () => {
    expect(compactionDividerLabelKey({ state: "done" })).toEqual({
      key: "ui.messagePart.compaction",
    })
  })

  test("aborted returns aborted key", () => {
    expect(compactionDividerLabelKey({ state: "aborted" })).toEqual({
      key: "ui.messagePart.compaction.aborted",
    })
  })

  test("failed + ContextOverflowError → context overflow key with no reason", () => {
    expect(
      compactionDividerLabelKey({
        state: "failed",
        error: { name: "ContextOverflowError", message: "too large" },
      }),
    ).toEqual({ key: "ui.messagePart.compaction.failedContextOverflow" })
  })

  test("failed + generic error → reason placeholder (no double 'Compaction failed: Compaction failed')", () => {
    const result = compactionDividerLabelKey({
      state: "failed",
      error: { name: "APIError", message: "stream closed" },
    })
    expect(result).toEqual({ key: "ui.messagePart.compaction.failed", params: { reason: "stream closed" } })
    expect(result).not.toMatchObject({ key: "ui.messagePart.compaction.failed", params: { reason: /failed/i } })
  })
})

describe("compactionElapsedSeconds", () => {
  test("pending without summary → counts from user time.created", () => {
    expect(
      compactionElapsedSeconds({
        state: "pending",
        summaryAssistant: undefined,
        compactionUserMessage: user({ time: { created: 10_000 } }),
        now: 13_000,
      }),
    ).toBe(3)
  })

  test("pending with summary → counts from summary time.created", () => {
    expect(
      compactionElapsedSeconds({
        state: "pending",
        summaryAssistant: summary({ time: { created: 11_500 } }),
        compactionUserMessage: user({ time: { created: 10_000 } }),
        now: 13_000,
      }),
    ).toBe(1)
  })

  test("non-pending state → 0", () => {
    expect(
      compactionElapsedSeconds({
        state: "done",
        summaryAssistant: summary(),
        compactionUserMessage: user(),
        now: 99_000,
      }),
    ).toBe(0)
  })

  test("negative clock drift clamps to 0", () => {
    expect(
      compactionElapsedSeconds({
        state: "pending",
        summaryAssistant: undefined,
        compactionUserMessage: user({ time: { created: 10_000 } }),
        now: 9_000,
      }),
    ).toBe(0)
  })
})

describe("formatCompactionElapsed", () => {
  test("< 60s → seconds form", () => {
    expect(formatCompactionElapsed(0)).toBe("0s")
    expect(formatCompactionElapsed(45)).toBe("45s")
    expect(formatCompactionElapsed(59)).toBe("59s")
  })

  test(">= 60s → minutes + seconds form", () => {
    expect(formatCompactionElapsed(60)).toBe("1m 0s")
    expect(formatCompactionElapsed(78)).toBe("1m 18s")
    expect(formatCompactionElapsed(3_661)).toBe("61m 1s")
  })
})
