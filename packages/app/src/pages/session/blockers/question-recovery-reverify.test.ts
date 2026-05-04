import { describe, expect, test } from "bun:test"
import { questionRecoveryReverify, type ReverifyDeps } from "./question-recovery-reverify"
import type { ReverifyContext } from "./question-recovery-clock"
import type { QuestionRecoverySnapshot } from "./question-recovery-snapshot"

interface FakeQuestion {
  id: string
  sessionID: string
  tool?: { messageID: string; callID: string }
}

const ctx: ReverifyContext = {
  armedAt: 0,
  armedDirectory: "/dir",
  firedAt: 100,
}

const missing: QuestionRecoverySnapshot = { kind: "missingRunning" }
const ready: QuestionRecoverySnapshot = { kind: "ready" }

interface HarnessOpts {
  snapshot?: QuestionRecoverySnapshot
  activeSid?: string
  directory?: string
  busy?: boolean
  list?: () => Promise<readonly FakeQuestion[]>
  messages?: unknown
  parts?: Record<string, ReadonlyArray<unknown>>
}

const setup = (opts: HarnessOpts = {}) => {
  const hydrated: { sid: string; questions: readonly FakeQuestion[] }[] = []
  const warns: { msg: string; payload: Record<string, unknown> }[] = []
  const deps: ReverifyDeps<FakeQuestion> = {
    snapshot: () => opts.snapshot ?? missing,
    activeSessionID: () => opts.activeSid ?? "s",
    activeDirectory: () => opts.directory ?? "/dir",
    isSessionBusy: () => opts.busy ?? true,
    listQuestions: opts.list ?? (async () => []),
    messagesFor: () => opts.messages,
    partsByMessageID: () => opts.parts ?? {},
    applyHydration: (sid, questions) => {
      hydrated.push({ sid, questions })
    },
    warn: (msg, payload) => warns.push({ msg, payload }),
  }
  return { deps, hydrated, warns }
}

describe("questionRecoveryReverify", () => {
  test("guard 1: snapshot moved off missingRunning → proceed:false, no list", async () => {
    let called = false
    const { deps } = setup({
      snapshot: ready,
      list: async () => {
        called = true
        return []
      },
    })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false })
    expect(called).toBe(false)
  })

  test("guard 2: active session changed → proceed:false", async () => {
    const { deps } = setup({ activeSid: "other" })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false })
  })

  test("guard 2: directory drifted from armedDirectory → proceed:false", async () => {
    const { deps } = setup({ directory: "/other" })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false })
  })

  test("guard 3: session no longer busy → proceed:false", async () => {
    const { deps } = setup({ busy: false })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false })
  })

  test("list() throws → proceed:false + retry:true (one bounded follow-up)", async () => {
    const { deps, warns } = setup({
      list: async () => {
        throw new Error("network down")
      },
    })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false, retry: true })
    expect(warns).toHaveLength(1)
    expect(warns[0].msg).toContain("question.list() failed")
  })

  test("post-await guard re-check: snapshot flipped during list → proceed:false", async () => {
    let snap: QuestionRecoverySnapshot = missing
    const { deps } = setup({
      list: async () => {
        snap = ready
        return []
      },
    })
    deps.snapshot = () => snap
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false })
  })

  // Running parts use top-level `callID/messageID` to match the real ToolPart
  // SDK shape — fallback reads them at part level, not from `state`.
  const runningQuestionPart = (callID: string, messageID: string) => ({
    type: "tool",
    tool: "question",
    state: { status: "running", input: { id: "q1" } },
    callID,
    messageID,
  })

  test("server returns no covering question → proceed:true (halt is licensed)", async () => {
    // syncQuestions empty + a running question part means fallback finds the
    // session as "still uncovered", so the clock is allowed to halt.
    const { deps, hydrated } = setup({
      list: async () => [],
      messages: [{ id: "m1", role: "assistant" }],
      parts: { m1: [runningQuestionPart("c1", "m1")] },
    })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: true })
    // No hydration when server has nothing to write back.
    expect(hydrated).toEqual([])
  })

  test("server now covers the question → hydrate sync + proceed:false", async () => {
    // Server returns a question whose tool.(messageID, callID) matches the
    // running part — fallback now finds it covered.
    const covering: FakeQuestion = {
      id: "q1",
      sessionID: "s",
      tool: { messageID: "m1", callID: "c1" },
    }
    const { deps, hydrated } = setup({
      list: async () => [covering],
      messages: [{ id: "m1", role: "assistant" }],
      parts: { m1: [runningQuestionPart("c1", "m1")] },
    })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: false })
    expect(hydrated).toHaveLength(1)
    expect(hydrated[0]).toEqual({ sid: "s", questions: [covering] })
  })

  test("list returns questions for other sessions only → still uncovered → proceed:true", async () => {
    const other: FakeQuestion = {
      id: "q2",
      sessionID: "other-sid",
      tool: { messageID: "m1", callID: "c1" },
    }
    const { deps, hydrated } = setup({
      list: async () => [other],
      messages: [{ id: "m1", role: "assistant" }],
      parts: { m1: [runningQuestionPart("c1", "m1")] },
    })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: true })
    expect(hydrated).toEqual([])
  })

  // Identity match means the *exact* (messageID, callID) pair, not just the
  // session. Server may legitimately have other questions for the same
  // session that point at a different tool call; halt must still be licensed
  // because the running part remains uncovered.
  test("server returns same-session question with mismatched callID → proceed:true", async () => {
    const sameSessionWrongCall: FakeQuestion = {
      id: "q-other",
      sessionID: "s",
      tool: { messageID: "m1", callID: "different-call" },
    }
    const { deps, hydrated } = setup({
      list: async () => [sameSessionWrongCall],
      messages: [{ id: "m1", role: "assistant" }],
      parts: { m1: [runningQuestionPart("c1", "m1")] },
    })
    const result = await questionRecoveryReverify(deps, "s", ctx)
    expect(result).toEqual({ proceed: true })
    expect(hydrated).toEqual([])
  })
})
