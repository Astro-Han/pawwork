import { describe, expect, test } from "bun:test"
import type { Message, Part, QuestionRequest, ToolState } from "@opencode-ai/sdk/v2"
import { resolveQuestionRecoverySnapshot } from "./question-recovery-snapshot"

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

describe("resolveQuestionRecoverySnapshot", () => {
  test("none when no sessionID", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: undefined,
        sessionTreeQuestionRequest: undefined,
        activeSessionSyncQuestions: [],
        activeSessionMessages: undefined,
        partsByMessageID: {},
      }),
    ).toEqual({ kind: "none" })
  })

  test("none when no running question and no sync entry", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "s",
        sessionTreeQuestionRequest: undefined,
        activeSessionSyncQuestions: [],
        activeSessionMessages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "todowrite", "running")] },
      }),
    ).toEqual({ kind: "none" })
  })

  test("ready when tree-walked question request resolves (active session)", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "s",
        sessionTreeQuestionRequest: { id: "q1" },
        activeSessionSyncQuestions: [syncQ("q1", "s", { messageID: "m1", callID: "c1" })],
        activeSessionMessages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toEqual({ kind: "ready" })
  })

  // P2-3 lock: parent ready continues to surface via tree-walked request even
  // though the active session is the child.
  test("ready when running part lives in parent session and sync has matching entry", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "child",
        sessionTreeQuestionRequest: { id: "q_parent" },
        activeSessionSyncQuestions: [],
        activeSessionMessages: [],
        partsByMessageID: {},
      }),
    ).toEqual({ kind: "ready" })
  })

  test("missingRunning when active session has running question with no matching sync identity", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "s",
        sessionTreeQuestionRequest: undefined,
        activeSessionSyncQuestions: [],
        activeSessionMessages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toEqual({ kind: "missingRunning" })
  })

  // P1-2 lock: legacy sync entry without tool identity covers one running
  // part. Snapshot must not raise missingRunning here, matching fallback.
  test("not missingRunning when legacy sync entry without identity covers running part", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "s",
        sessionTreeQuestionRequest: undefined,
        activeSessionSyncQuestions: [syncQ("q_legacy", "s")],
        activeSessionMessages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toEqual({ kind: "none" })
  })

  // P2-3 lock: subagents cannot use the question tool today; missingRunning
  // detection only looks at the active session. Cross-session running parts
  // are intentionally ignored until subagents gain question access.
  test("missingRunning is NOT raised when running part lives in a parent (asymmetric by design)", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "child",
        sessionTreeQuestionRequest: undefined,
        activeSessionSyncQuestions: [],
        activeSessionMessages: [],
        partsByMessageID: { m_parent: [toolPart("p", "question", "running", { messageID: "m_parent", callID: "c1" })] },
      }),
    ).toEqual({ kind: "none" })
  })

  test("ready takes precedence over missingRunning when both could apply", () => {
    expect(
      resolveQuestionRecoverySnapshot({
        sessionID: "s",
        sessionTreeQuestionRequest: { id: "q1" },
        activeSessionSyncQuestions: [],
        activeSessionMessages: [message("m1")],
        partsByMessageID: { m1: [toolPart("p1", "question", "running", { messageID: "m1", callID: "c1" })] },
      }),
    ).toEqual({ kind: "ready" })
  })
})
