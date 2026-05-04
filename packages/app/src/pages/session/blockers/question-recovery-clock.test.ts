import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createQuestionRecoveryClock, HEAL_DELAY_MS } from "./question-recovery-clock"
import type { QuestionRecoverySnapshot } from "./question-recovery-snapshot"

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

const ready: QuestionRecoverySnapshot = { kind: "ready" }
const none: QuestionRecoverySnapshot = { kind: "none" }
const missing: QuestionRecoverySnapshot = { kind: "missingRunning" }

interface Harness {
  clock: ReturnType<typeof createQuestionRecoveryClock>
  setSnap: (s: QuestionRecoverySnapshot) => void
  fk: ReturnType<typeof fakeClock>
  haltCalls: string[]
  warnCalls: { message: string; payload: Record<string, unknown> }[]
  haltImpl?: (s: string) => Promise<unknown>
  reverifyImpl?: () => Promise<{ proceed: boolean }>
  dispose: () => void
}

const setupHarness = (overrides?: {
  haltImpl?: (s: string) => Promise<unknown>
  reverifyImpl?: () => Promise<{ proceed: boolean }>
  delayMs?: number
}): Harness => {
  const fk = fakeClock()
  const haltCalls: string[] = []
  const warnCalls: { message: string; payload: Record<string, unknown> }[] = []
  let setSnap!: (s: QuestionRecoverySnapshot) => void
  let clock!: ReturnType<typeof createQuestionRecoveryClock>
  const dispose = createRoot((d) => {
    const [snap, setS] = createSignal<QuestionRecoverySnapshot>(none)
    setSnap = (s) => {
      setS(s)
      clock.tick()
    }
    clock = createQuestionRecoveryClock({
      snapshot: snap,
      activeSessionID: () => "s",
      activeDirectory: () => "/dir",
      halt:
        overrides?.haltImpl ??
        (async (s: string) => {
          haltCalls.push(s)
        }),
      reverify: overrides?.reverifyImpl ?? (async () => ({ proceed: true })),
      delayMs: overrides?.delayMs ?? HEAL_DELAY_MS,
      now: fk.now,
      setTimer: fk.setTimer,
      clearTimer: fk.clearTimer,
      warn: (m, p) => warnCalls.push({ message: m, payload: p }),
    })
    return d
  })
  return { clock, setSnap, fk, haltCalls, warnCalls, dispose }
}

describe("createQuestionRecoveryClock", () => {
  test("transition to missingRunning arms a timer; halt called after delay", async () => {
    const h = setupHarness()
    h.setSnap(missing)
    expect(h.fk.pending()).toBe(1)
    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual(["s"])
    h.dispose()
  })

  test("transition back to ready before fire clears the timer; halt not called", async () => {
    const h = setupHarness()
    h.setSnap(missing)
    h.setSnap(ready)
    h.fk.advance(HEAL_DELAY_MS + 100)
    await flush()
    expect(h.haltCalls).toEqual([])
    h.dispose()
  })

  test("transition back to none before fire clears the timer; halt not called", async () => {
    const h = setupHarness()
    h.setSnap(missing)
    h.setSnap(none)
    h.fk.advance(HEAL_DELAY_MS + 100)
    await flush()
    expect(h.haltCalls).toEqual([])
    h.dispose()
  })

  test("reverify proceed=false → halt NOT called", async () => {
    const h = setupHarness({ reverifyImpl: async () => ({ proceed: false }) })
    h.setSnap(missing)
    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual([])
    h.dispose()
  })

  test("halt() throws → structured warn logged, map entry deleted, no retry", async () => {
    let haltCount = 0
    const h = setupHarness({
      haltImpl: async () => {
        haltCount++
        throw new Error("halt boom")
      },
    })
    h.setSnap(missing)
    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(haltCount).toBe(1)
    expect(h.warnCalls.length).toBe(1)
    expect(h.warnCalls[0].message).toContain("halt failed")
    expect(h.warnCalls[0].payload).toMatchObject({ sessionID: "s", directory: "/dir" })
    expect(typeof h.warnCalls[0].payload.armedAt).toBe("number")
    expect(typeof h.warnCalls[0].payload.firedAt).toBe("number")
    expect(h.clock.pendingFor("s")).toBe(false)
    h.dispose()
  })

  test("snapshot stays missingRunning after fire → no re-arm (v5 P2-2 lock)", async () => {
    const h = setupHarness()
    h.setSnap(missing)
    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual(["s"])

    // Same-kind set after fire must not arm a second timer.
    h.setSnap(missing)
    h.fk.advance(HEAL_DELAY_MS * 2)
    await flush()
    expect(h.haltCalls).toEqual(["s"])

    // After leaving and returning, a fresh edge re-arms.
    h.setSnap(none)
    h.setSnap(missing)
    expect(h.fk.pending()).toBe(1)
    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual(["s", "s"])
    h.dispose()
  })

  test("reverify threw → warn logged, halt NOT called", async () => {
    const h = setupHarness({
      reverifyImpl: async () => {
        throw new Error("reverify boom")
      },
    })
    h.setSnap(missing)
    h.fk.advance(HEAL_DELAY_MS)
    await flush()
    expect(h.haltCalls).toEqual([])
    expect(h.warnCalls.length).toBe(1)
    expect(h.warnCalls[0].message).toContain("reverify threw")
    expect(h.warnCalls[0].payload).toMatchObject({ sessionID: "s" })
    h.dispose()
  })

  test("dispose clears all pending timers", () => {
    const h = setupHarness()
    h.setSnap(missing)
    expect(h.fk.pending()).toBe(1)
    h.dispose()
    expect(h.fk.pending()).toBe(0)
  })
})
