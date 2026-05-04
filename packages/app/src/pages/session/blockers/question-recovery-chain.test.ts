import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Message, Part, QuestionRequest, ToolState } from "@opencode-ai/sdk/v2"
import { createQuestionRecoveryClock, HEAL_DELAY_MS } from "./question-recovery-clock"
import { resolveQuestionRecoverySnapshot, type QuestionRecoverySnapshot } from "./question-recovery-snapshot"
import { questionRecoveryReverify, type ReverifyDeps } from "./question-recovery-reverify"

// End-to-end auto-heal chain: snapshot reducer + clock + reverify wired
// against the same mutable harness state. Tests the recovery contract as a
// whole — snapshot edge → clock arm → reverify → halt or hydrate — instead
// of trusting that three correct pieces compose correctly. See #419.

interface FakeTimer {
  cb: () => void
  fireAt: number
  cancelled: boolean
}

function fakeClock() {
  let nowMs = 0
  const timers: FakeTimer[] = []
  return {
    now: () => nowMs,
    advance(by: number) {
      nowMs += by
      for (const t of timers) {
        if (t.cancelled) continue
        if (t.fireAt <= nowMs) {
          t.cancelled = true
          t.cb()
        }
      }
    },
    setTimer: (cb: () => void, ms: number) => {
      const t: FakeTimer = { cb, fireAt: nowMs + ms, cancelled: false }
      timers.push(t)
      return t
    },
    clearTimer: (handle: unknown) => {
      ;(handle as FakeTimer).cancelled = true
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const message = (id: string): Message => ({ id }) as Message

const toolState = (status: ToolState["status"], input: Record<string, unknown> = {}): ToolState =>
  ({
    status,
    input,
    title: "",
    metadata: {},
    time: { start: 0 },
  }) as ToolState

const runningQuestionPart = (callID: string, messageID: string): Part =>
  ({
    id: callID,
    type: "tool",
    tool: "question",
    state: toolState("running", { id: "q1" }),
    callID,
    messageID,
  }) as Part

const SID = "ses_chain"
const DIR = "/dir"

interface Harness {
  // Inputs that drive the snapshot reducer + reverify.
  setSyncQuestions: (q: ReadonlyArray<QuestionRequest>) => void
  setMessages: (m: ReadonlyArray<Message>) => void
  setParts: (p: Record<string, ReadonlyArray<Part>>) => void
  setBusy: (b: boolean) => void
  setActiveSid: (s: string | undefined) => void
  setDirectory: (d: string) => void
  setListImpl: (impl: () => Promise<readonly QuestionRequest[]>) => void
  setHaltImpl: (impl: () => Promise<unknown>) => void
  // Observed effects.
  haltCalls: string[]
  hydrationCalls: { sid: string; questions: readonly QuestionRequest[] }[]
  warnCalls: { message: string; payload: Record<string, unknown> }[]
  fk: ReturnType<typeof fakeClock>
  // Drive snapshot recompute on input change (production goes via memo).
  recompute: () => void
  dispose: () => void
}

const setupChain = (initial?: {
  syncQuestions?: ReadonlyArray<QuestionRequest>
  messages?: ReadonlyArray<Message>
  parts?: Record<string, ReadonlyArray<Part>>
  busy?: boolean
  activeSid?: string
  directory?: string
  listImpl?: () => Promise<readonly QuestionRequest[]>
  haltImpl?: () => Promise<unknown>
}): Harness => {
  const fk = fakeClock()
  const haltCalls: string[] = []
  const hydrationCalls: { sid: string; questions: readonly QuestionRequest[] }[] = []
  const warnCalls: { message: string; payload: Record<string, unknown> }[] = []

  let setSync!: (q: ReadonlyArray<QuestionRequest>) => void
  let setMsgs!: (m: ReadonlyArray<Message>) => void
  let setPartsSig!: (p: Record<string, ReadonlyArray<Part>>) => void
  let setBusySig!: (b: boolean) => void
  let setSid!: (s: string | undefined) => void
  let setDir!: (d: string) => void
  let recompute!: () => void

  let listImpl: () => Promise<readonly QuestionRequest[]> = initial?.listImpl ?? (async () => [])
  let haltImpl: () => Promise<unknown> =
    initial?.haltImpl ??
    (async () => {
      // default
    })

  const dispose = createRoot((d) => {
    const [sync, sSync] = createSignal<ReadonlyArray<QuestionRequest>>(initial?.syncQuestions ?? [])
    const [msgs, sMsgs] = createSignal<ReadonlyArray<Message>>(initial?.messages ?? [])
    const [parts, sParts] = createSignal<Record<string, ReadonlyArray<Part>>>(initial?.parts ?? {})
    const [busy, sBusy] = createSignal(initial?.busy ?? true)
    const [sid, sSid] = createSignal<string | undefined>(initial?.activeSid ?? SID)
    const [dir, sDir] = createSignal(initial?.directory ?? DIR)
    const [snap, sSnap] = createSignal<QuestionRecoverySnapshot>({ kind: "none" })

    setSync = sSync
    setMsgs = sMsgs
    setPartsSig = sParts
    setBusySig = sBusy
    setSid = sSid
    setDir = sDir

    recompute = () => {
      const next = resolveQuestionRecoverySnapshot({
        sessionID: sid(),
        sessionTreeQuestionRequest: undefined,
        activeSessionSyncQuestions: sync(),
        activeSessionMessages: msgs(),
        partsByMessageID: parts(),
      })
      sSnap(next)
      clock.tick()
    }

    const reverifyDeps: ReverifyDeps<QuestionRequest> = {
      snapshot: snap,
      activeSessionID: sid,
      activeDirectory: dir,
      isSessionBusy: () => busy(),
      listQuestions: () => listImpl(),
      messagesFor: () => msgs(),
      partsByMessageID: () => parts(),
      applyHydration: (s, qs) => hydrationCalls.push({ sid: s, questions: qs }),
      warn: (m, p) => warnCalls.push({ message: m, payload: p }),
    }

    const clock = createQuestionRecoveryClock({
      snapshot: snap,
      activeSessionID: sid,
      activeDirectory: dir,
      halt: async (s) => {
        haltCalls.push(s)
        return haltImpl()
      },
      reverify: (s, ctx) => questionRecoveryReverify(reverifyDeps, s, ctx),
      now: fk.now,
      setTimer: fk.setTimer,
      clearTimer: fk.clearTimer,
      warn: (m, p) => warnCalls.push({ message: m, payload: p }),
    })

    return d
  })

  // Initialise snapshot once before tests interact.
  recompute()

  return {
    setSyncQuestions: (q) => {
      setSync(q)
      recompute()
    },
    setMessages: (m) => {
      setMsgs(m)
      recompute()
    },
    setParts: (p) => {
      setPartsSig(p)
      recompute()
    },
    setBusy: setBusySig,
    setActiveSid: (s) => {
      setSid(s)
      recompute()
    },
    setDirectory: (d) => {
      setDir(d)
      recompute()
    },
    setListImpl: (impl) => {
      listImpl = impl
    },
    setHaltImpl: (impl) => {
      haltImpl = impl
    },
    haltCalls,
    hydrationCalls,
    warnCalls,
    fk,
    recompute,
    dispose,
  }
}

describe("question recovery chain", () => {
  test("missingRunning edge → reverify (still uncovered) → halt fires", async () => {
    const h = setupChain()

    // Drop into missingRunning: assistant message has a running question
    // part with no covering sync entry.
    h.setMessages([message("m1")])
    h.setParts({ m1: [runningQuestionPart("c1", "m1")] })
    expect(h.fk.pending()).toBe(1)

    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual([SID])
    expect(h.hydrationCalls).toEqual([])
    h.dispose()
  })

  test("server hydrates the missing question before fire → reverify writes it back, halt skipped", async () => {
    const covering = {
      id: "q1",
      sessionID: SID,
      tool: { messageID: "m1", callID: "c1" },
    } as unknown as QuestionRequest
    const h = setupChain()
    h.setMessages([message("m1")])
    h.setParts({ m1: [runningQuestionPart("c1", "m1")] })
    expect(h.fk.pending()).toBe(1)

    // Server now reports the covering question — reverify will hydrate sync
    // and refuse to halt because the running part is no longer uncovered.
    h.setListImpl(async () => [covering])

    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual([])
    expect(h.hydrationCalls).toHaveLength(1)
    expect(h.hydrationCalls[0]).toEqual({ sid: SID, questions: [covering] })
    h.dispose()
  })

  test("transient list() failure → bounded retry → recovery on follow-up halts", async () => {
    let attempts = 0
    const h = setupChain()
    h.setListImpl(async () => {
      attempts++
      if (attempts === 1) throw new Error("server blip")
      return []
    })
    h.setMessages([message("m1")])
    h.setParts({ m1: [runningQuestionPart("c1", "m1")] })

    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(attempts).toBe(1)
    expect(h.haltCalls).toEqual([])
    expect(h.fk.pending()).toBe(1)

    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(attempts).toBe(2)
    expect(h.haltCalls).toEqual([SID])
    h.dispose()
  })

  test("session leaves missingRunning before timer fires → halt skipped, no hydration", async () => {
    const covering = {
      id: "q1",
      sessionID: SID,
      tool: { messageID: "m1", callID: "c1" },
    } as unknown as QuestionRequest
    const h = setupChain()
    h.setMessages([message("m1")])
    h.setParts({ m1: [runningQuestionPart("c1", "m1")] })
    expect(h.fk.pending()).toBe(1)

    // Sync receives the covering entry before the timer expires — snapshot
    // flips to "none" and the clock cancels its timer.
    h.setSyncQuestions([covering])
    expect(h.fk.pending()).toBe(0)

    h.fk.advance(HEAL_DELAY_MS * 2)
    await flush()
    expect(h.haltCalls).toEqual([])
    expect(h.hydrationCalls).toEqual([])
    h.dispose()
  })
})
