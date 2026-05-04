import { describe, expect, test } from "bun:test"
import type { Message, Part, QuestionRequest, ToolState } from "@opencode-ai/sdk/v2"
import { findRunningQuestionFallbackSession } from "./question-fallback"

const message = (id: string): Message => ({ id }) as Message

const toolState = (status: ToolState["status"]): ToolState =>
  ({
    status,
    input: {},
    title: "",
    metadata: {},
    time: { start: 0 },
  }) as ToolState

const toolPart = (
  id: string,
  tool: string,
  status: ToolState["status"] = "running",
  attrs?: { messageID?: string; callID?: string },
): Part =>
  ({
    id,
    type: "tool",
    tool,
    state: toolState(status),
    messageID: attrs?.messageID,
    callID: attrs?.callID,
  }) as Part

const syncQ = (id: string, sessionID: string, tool?: { messageID: string; callID: string }): QuestionRequest =>
  ({
    id,
    sessionID,
    questions: [{ header: "h", question: "q", options: [] }],
    tool,
  }) as QuestionRequest

describe("findRunningQuestionFallbackSession", () => {
  test("returns undefined without a session", () => {
    expect(findRunningQuestionFallbackSession({ syncQuestions: [], partsByMessageID: {} })).toBeUndefined()
  })

  test("returns undefined when sync entry matches the running part by (messageID, callID)", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        syncQuestions: [syncQ("q1", "s", { messageID: "m1", callID: "c1" })],
        messages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toBeUndefined()
  })

  test("triggers when running part has no matching sync entry by identity", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        // sync has an entry, but its tool identity points to a different call
        syncQuestions: [syncQ("q_other", "s", { messageID: "m1", callID: "c_other" })],
        messages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toBe("s")
  })

  test("triggers when running parts outnumber matched sync entries (multi-pending parallel)", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        // only q1 matches; q2 q3 are running but unknown to sync
        syncQuestions: [syncQ("q1", "s", { messageID: "m1", callID: "c1" })],
        messages: [message("m1"), message("m2"), message("m3")],
        partsByMessageID: {
          m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })],
          m2: [toolPart("p2", "question", "running", { messageID: "m2", callID: "c2" })],
          m3: [toolPart("p3", "question", "running", { messageID: "m3", callID: "c3" })],
        },
      }),
    ).toBe("s")
  })

  test("ignores non-running question parts and other tools", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        syncQuestions: [],
        messages: [message("m1"), message("m2")],
        partsByMessageID: {
          m1: [toolPart("p1", "question", "completed", { messageID: "m1", callID: "c1" })],
          m2: [toolPart("p2", "todowrite", "running", { messageID: "m2", callID: "c2" })],
        },
      }),
    ).toBeUndefined()
  })

  test("triggers for a running question part beyond the legacy 5-message window", () => {
    const messages = Array.from({ length: 50 }, (_, i) => message(`m${i}`))
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        syncQuestions: [],
        messages,
        partsByMessageID: { m0: [toolPart("p0", "question", "running", { messageID: "m0", callID: "c0" })] },
      }),
    ).toBe("s")
  })

  test("falls back to count check when neither side has tool identity", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        // sync entry without tool identity, running part also missing identity
        syncQuestions: [syncQ("q1", "s")],
        messages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running")] },
      }),
    ).toBeUndefined()
  })

  test("count fallback triggers when running-without-identity exceeds entries-without-identity", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        syncQuestions: [],
        messages: [message("m1"), message("m2")],
        partsByMessageID: {
          m1: [toolPart("p1", "question", "running")],
          m2: [toolPart("p2", "question", "running")],
        },
      }),
    ).toBe("s")
  })

  // Mixed-state guard for #419: when a sync entry lacks tool identity but a
  // running part has identity, the legacy entry should still cover it. Pre-fix
  // behavior would treat the running part as missing and trigger fallback,
  // even though the sync entry was a legitimate (legacy-shaped) match.
  test("legacy sync entry without identity absorbs running part with identity", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        syncQuestions: [syncQ("q_legacy", "s")],
        messages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toBeUndefined()
  })
})
