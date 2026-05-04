import { createEffect, onCleanup } from "solid-js"
import type { QuestionRecoverySnapshot } from "./question-recovery-snapshot"

export const HEAL_DELAY_MS = 3_000

export interface ReverifyContext {
  armedAt: number
  armedDirectory: string
  firedAt: number
}

// `retry` lets reverify ask the clock to re-arm a single follow-up timer
// without waiting for a snapshot edge — used for transient failures
// (e.g. server question.list() blip) so a sticky stuck session does not
// dead-end on a single error.
export type ReverifyOutcome = { proceed: true } | { proceed: false; retry?: boolean }

export interface ClockInput {
  snapshot: () => QuestionRecoverySnapshot
  activeSessionID: () => string | undefined
  activeDirectory: () => string
  halt: (sessionID: string) => Promise<unknown>
  reverify: (sessionID: string, ctx: ReverifyContext) => Promise<ReverifyOutcome>
  delayMs?: number
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  warn?: (message: string, payload: Record<string, unknown>) => void
}

export interface Clock {
  dispose: () => void
  pendingFor: (sessionID: string) => boolean
  // Test-only: drive a step manually. In production, createEffect calls this.
  tick: () => void
}

interface PendingEntry {
  handle: unknown
  armedAt: number
  armedDirectory: string
  retried: boolean
}

// Auto-heal clock. Edge-triggered arming (transition INTO missingRunning),
// at-most-once fire per arm (map entry deleted before any await), all guards
// run inside consumer-supplied reverify. See spec v6.
//
// Production wires the clock's tick() into createEffect; tests call tick()
// directly because the SSR build of solid-js used in unit tests does not
// propagate signal updates through effects.
export function createQuestionRecoveryClock(input: ClockInput): Clock {
  const delayMs = input.delayMs ?? HEAL_DELAY_MS
  const now = input.now ?? (() => Date.now())
  const setTimer =
    input.setTimer ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as ReturnType<typeof setTimeout>)
  const clearTimer =
    input.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const warn = input.warn ?? ((m, p) => console.warn(m, p))

  const pending = new Map<string, PendingEntry>()
  const lastSeen = new Map<string, QuestionRecoverySnapshot["kind"]>()
  let lastActiveSid: string | undefined
  let disposed = false

  const cancelFor = (sessionID: string) => {
    const entry = pending.get(sessionID)
    if (!entry) return
    clearTimer(entry.handle)
    pending.delete(sessionID)
  }

  const forget = (sessionID: string) => {
    cancelFor(sessionID)
    lastSeen.delete(sessionID)
  }

  const fire = async (sessionID: string) => {
    const entry = pending.get(sessionID)
    if (!entry) return
    pending.delete(sessionID)
    if (disposed) return

    const ctx: ReverifyContext = {
      armedAt: entry.armedAt,
      armedDirectory: entry.armedDirectory,
      firedAt: now(),
    }
    let outcome: ReverifyOutcome
    try {
      outcome = await input.reverify(sessionID, ctx)
    } catch (err) {
      warn("question-recovery: reverify threw", {
        sessionID,
        directory: entry.armedDirectory,
        armedAt: entry.armedAt,
        firedAt: ctx.firedAt,
        err,
      })
      return
    }
    if (disposed) return
    if (!outcome.proceed) {
      // Bounded retry: at most one follow-up attempt per arm. A second
      // transient failure must wait for a fresh snapshot edge instead of
      // looping the server every delayMs forever.
      if (outcome.retry && !entry.retried && input.activeSessionID() === sessionID) {
        const handle = setTimer(() => {
          void fire(sessionID)
        }, delayMs)
        pending.set(sessionID, {
          handle,
          armedAt: now(),
          armedDirectory: entry.armedDirectory,
          retried: true,
        })
      }
      return
    }

    try {
      await input.halt(sessionID)
    } catch (err) {
      warn("question-recovery: halt failed", {
        sessionID,
        directory: entry.armedDirectory,
        armedAt: entry.armedAt,
        firedAt: ctx.firedAt,
        err,
      })
    }
  }

  const tick = () => {
    if (disposed) return
    const sid = input.activeSessionID()
    const snap = input.snapshot()

    // Session navigation: drop the previous session's pending timer and
    // edge state so coming back to a still-stuck session re-arms cleanly
    // instead of hitting a stale lastSeen=missingRunning entry. This also
    // bounds lastSeen to at most one entry at any time.
    if (lastActiveSid && lastActiveSid !== sid) forget(lastActiveSid)
    lastActiveSid = sid

    if (!sid) return

    const previousKind = lastSeen.get(sid)
    lastSeen.set(sid, snap.kind)

    if (snap.kind === "missingRunning") {
      if (previousKind === "missingRunning") return
      if (pending.has(sid)) return
      const armedAt = now()
      const armedDirectory = input.activeDirectory()
      const handle = setTimer(() => {
        void fire(sid)
      }, delayMs)
      pending.set(sid, { handle, armedAt, armedDirectory, retried: false })
      return
    }

    cancelFor(sid)
  }

  const disposeAll = () => {
    disposed = true
    for (const entry of pending.values()) clearTimer(entry.handle)
    pending.clear()
    lastSeen.clear()
  }

  createEffect(tick)
  onCleanup(disposeAll)

  return {
    dispose: disposeAll,
    pendingFor: (sessionID: string) => pending.has(sessionID),
    tick,
  }
}
