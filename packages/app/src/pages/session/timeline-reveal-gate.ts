import { createEffect, createSignal, on, onCleanup } from "solid-js"

export type RevealGatePhase = "loading" | "settling" | "revealed"

export type RevealGateState = {
  sessionKey: string
  phase: RevealGatePhase
  stableFrames: number
}

export type RevealGateEvent =
  | { type: "session"; sessionKey: string }
  | { type: "ready"; ready: boolean }
  | { type: "frame"; reconcilerActive: boolean }
  | { type: "timeout" }
  | { type: "release" }

export type RevealGateOptions = {
  /** Consecutive reconciler-inactive frames required before the cover lifts. */
  settleFrames?: number
}

const DEFAULT_SETTLE_FRAMES = 2

export function revealGateCovered(state: RevealGateState): boolean {
  return state.phase !== "revealed"
}

export function nextRevealGateState(
  previous: RevealGateState | undefined,
  event: RevealGateEvent,
  options?: RevealGateOptions,
): RevealGateState {
  if (event.type === "session") {
    if (previous && previous.sessionKey === event.sessionKey) return previous
    return { sessionKey: event.sessionKey, phase: "loading", stableFrames: 0 }
  }
  const state = previous ?? { sessionKey: "", phase: "loading", stableFrames: 0 }
  if (event.type === "ready") {
    if (event.ready && state.phase === "loading") return { ...state, phase: "settling", stableFrames: 0 }
    return state
  }
  if (event.type === "frame") {
    if (state.phase !== "settling") return state
    if (event.reconcilerActive) {
      // Keep the same object while the reconciler stays busy at zero stable
      // frames so the downstream signal does not churn every frame.
      if (state.stableFrames === 0) return state
      return { ...state, stableFrames: 0 }
    }
    const settleFrames = options?.settleFrames ?? DEFAULT_SETTLE_FRAMES
    const stableFrames = state.stableFrames + 1
    if (stableFrames >= settleFrames) return { ...state, phase: "revealed", stableFrames }
    return { ...state, stableFrames }
  }
  if (event.type === "timeout") {
    // Failsafe only after the timeline has content: never lift the cover on a
    // still-loading session, but cap how long a perpetually-resizing (streaming)
    // timeline can hold it.
    if (state.phase === "settling") return { ...state, phase: "revealed" }
    return state
  }
  if (event.type === "release") {
    // A user gesture (scroll, hash/message navigation) must never sit behind the
    // cover — reveal now regardless of settle progress.
    if (state.phase === "revealed") return state
    return { ...state, phase: "revealed" }
  }
  return state
}

const DEFAULT_TIMEOUT_MS = 400

export type RevealGateMachineInput = {
  settleFrames: number
  timeoutMs: number
  /** Messages for the current session are loaded (route ready). */
  ready: () => boolean
  /** The scroll reconciler is dirty or pinning this frame. */
  reconcilerActive: () => boolean
  scheduleFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  setTimer: (callback: () => void, ms: number) => number
  clearTimer: (handle: number) => void
  /** Called whenever the gate state changes (e.g. to drive a signal). */
  onChange?: (state: RevealGateState) => void
}

export type RevealGateMachine = {
  state: () => RevealGateState
  /** Open/switch to a session; re-covers and restarts the settle watch. */
  session: (sessionKey: string) => void
  /** Re-evaluate readiness (messages-ready signal changed). */
  notifyReady: () => void
  /** Force-reveal now (a user gesture took over). */
  release: () => void
  dispose: () => void
}

/**
 * Framework-free core of the reveal gate: owns the frame loop and failsafe timer
 * that decide when the opening cover lifts. Holds the cover until the freshly
 * mounted timeline has settled — at least `settleFrames` consecutive frames with
 * the reconciler quiet after messages are ready — so the first revealed frame is
 * the settled bottom, not a mid-render premature bottom. `timeoutMs` caps the
 * hold for perpetually-resizing (streaming) timelines.
 */
export function createRevealGateMachine(input: RevealGateMachineInput): RevealGateMachine {
  let current: RevealGateState = { sessionKey: "", phase: "loading", stableFrames: 0 }
  let frameHandle: number | undefined
  let timerHandle: number | undefined

  const dispatch = (event: RevealGateEvent) => {
    current = nextRevealGateState(current, event, { settleFrames: input.settleFrames })
    input.onChange?.(current)
  }
  const stopLoop = () => {
    if (frameHandle !== undefined) {
      input.cancelFrame(frameHandle)
      frameHandle = undefined
    }
  }
  const stopTimer = () => {
    if (timerHandle !== undefined) {
      input.clearTimer(timerHandle)
      timerHandle = undefined
    }
  }
  const pump = () => {
    frameHandle = input.scheduleFrame(() => {
      frameHandle = undefined
      dispatch({ type: "frame", reconcilerActive: input.reconcilerActive() })
      if (current.phase === "settling") pump()
      else stopTimer()
    })
  }

  // Entering `settling` (messages ready) is the only place the loop and timer
  // arm. Re-run on every session switch so a session that is already ready still
  // gets a fresh settle watch.
  const syncReady = () => {
    dispatch({ type: "ready", ready: input.ready() })
    if (current.phase !== "settling") return
    if (frameHandle === undefined) pump()
    if (timerHandle === undefined) {
      timerHandle = input.setTimer(() => {
        timerHandle = undefined
        dispatch({ type: "timeout" })
        stopLoop()
      }, input.timeoutMs)
    }
  }

  return {
    state: () => current,
    session: (sessionKey) => {
      dispatch({ type: "session", sessionKey })
      stopLoop()
      stopTimer()
      syncReady()
    },
    notifyReady: syncReady,
    release: () => {
      dispatch({ type: "release" })
      stopLoop()
      stopTimer()
    },
    dispose: () => {
      stopLoop()
      stopTimer()
    },
  }
}

export type TimelineRevealGateInput = {
  /** Stable timeline identity; a change re-covers and restarts loading. */
  sessionKey: () => string
  /** Messages for the current session are loaded (route ready). */
  ready: () => boolean
  /** The scroll reconciler is dirty or pinning this frame. */
  reconcilerActive: () => boolean
  settleFrames?: number
  timeoutMs?: number
  scheduleFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
  setTimer?: (callback: () => void, ms: number) => number
  clearTimer?: (handle: number) => void
}

export type TimelineRevealGate = {
  /** True while the opening cover should stay up. */
  covered: () => boolean
  /** Force-reveal now (user gesture took over). */
  release: () => void
}

/**
 * Solid wrapper around {@link createRevealGateMachine}: bridges the session key
 * and readiness signals into the machine and exposes `covered()` as a signal so
 * the opening cover re-renders. The loop/timer logic lives in the framework-free
 * machine; this is thin reactive glue.
 */
export function createTimelineRevealGate(input: TimelineRevealGateInput): TimelineRevealGate {
  const [state, setState] = createSignal<RevealGateState>({ sessionKey: "", phase: "loading", stableFrames: 0 })
  const machine = createRevealGateMachine({
    settleFrames: input.settleFrames ?? DEFAULT_SETTLE_FRAMES,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ready: input.ready,
    reconcilerActive: input.reconcilerActive,
    scheduleFrame: input.scheduleFrame ?? ((callback) => requestAnimationFrame(callback)),
    cancelFrame: input.cancelFrame ?? ((handle) => cancelAnimationFrame(handle)),
    setTimer: input.setTimer ?? ((callback, ms) => setTimeout(callback, ms) as unknown as number),
    clearTimer: input.clearTimer ?? ((handle) => clearTimeout(handle)),
    onChange: setState,
  })

  createEffect(on(input.sessionKey, (sessionKey) => machine.session(sessionKey)))
  createEffect(on(input.ready, () => machine.notifyReady(), { defer: true }))
  onCleanup(() => machine.dispose())

  return {
    covered: () => revealGateCovered(state()),
    release: machine.release,
  }
}
