import { describe, expect, test } from "bun:test"
import type {
  Message,
  Part,
  PermissionRequest,
  SessionDiffResponse,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { PendingExternalResultQuestion } from "./external-result-question"
import { dropSessionCaches, pickSessionCacheEvictions } from "./session-cache"

const msg = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const part = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

type CacheShape = {
  session_status: Record<string, SessionStatus | undefined>
  turn_change_aggregate: Record<string, SessionDiffResponse | undefined>
  todo: Record<string, Todo[] | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  external_result_question: Record<string, PendingExternalResultQuestion[] | undefined>
}

const emptyAggregate = (sessionID: string): SessionDiffResponse => ({ kind: "empty", sessionID })

describe("app session cache", () => {
  test("dropSessionCaches tolerates legacy cache shape without external_result_question", () => {
    const legacyStore = {
      session_status: { ses_1: { type: "busy" } as SessionStatus },
      turn_change_aggregate: { ses_1: emptyAggregate("ses_1") },
      todo: { ses_1: [] as Todo[] },
      message: { ses_1: [msg("msg_1", "ses_1")] },
      part: { msg_1: [part("prt_1", "ses_1", "msg_1")] },
      permission: { ses_1: [] as PermissionRequest[] },
    } as Omit<CacheShape, "external_result_question">
    const store = legacyStore as unknown as CacheShape

    expect(() => dropSessionCaches(store, ["ses_1"])).not.toThrow()
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.turn_change_aggregate.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
  })

  test("dropSessionCaches clears orphaned parts without message rows", () => {
    const store: CacheShape = {
      session_status: { ses_1: { type: "busy" } as SessionStatus },
      turn_change_aggregate: { ses_1: emptyAggregate("ses_1") },
      todo: { ses_1: [] as Todo[] },
      message: {},
      part: { msg_1: [part("prt_1", "ses_1", "msg_1")] },
      permission: { ses_1: [] as PermissionRequest[] },
      external_result_question: {
        ses_1: [
          {
            id: "msg_1:call_1",
            sessionID: "ses_1",
            questions: [{ question: "Continue?" }],
            messageID: "msg_1",
            callID: "call_1",
            partID: "prt_1",
          },
        ],
      },
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part.msg_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.turn_change_aggregate.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.external_result_question.ses_1).toBeUndefined()
  })

  test("dropSessionCaches clears message-backed parts", () => {
    const m = msg("msg_1", "ses_1")
    const store: CacheShape = {
      session_status: {},
      turn_change_aggregate: {},
      todo: {},
      message: { ses_1: [m] },
      part: { [m.id]: [part("prt_1", "ses_1", m.id)] },
      permission: {},
      external_result_question: {},
    }

    dropSessionCaches(store, ["ses_1"])

    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[m.id]).toBeUndefined()
  })

  test("pickSessionCacheEvictions preserves requested sessions", () => {
    const seen = new Set(["ses_1", "ses_2", "ses_3"])

    const stale = pickSessionCacheEvictions({
      seen,
      keep: "ses_4",
      limit: 2,
      preserve: ["ses_1"],
    })

    expect(stale).toEqual(["ses_2", "ses_3"])
    expect([...seen]).toEqual(["ses_1", "ses_4"])
  })
})
