import { describe, expect, test } from "bun:test"
import {
  createRevealGateMachine,
  nextRevealGateState,
  revealGateCovered,
  type RevealGateEvent,
  type RevealGateOptions,
  type RevealGateState,
} from "./timeline-reveal-gate"

/** A frame scheduler whose callbacks run only when `step` is called. */
function makeFrameQueue() {
  const callbacks = new Map<number, () => void>()
  let nextHandle = 1
  return {
    schedule: (callback: () => void) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    cancel: (handle: number) => {
      callbacks.delete(handle)
    },
    /** Run the oldest queued frame (the loop re-queues the next one itself). */
    step: () => {
      const entry = callbacks.entries().next().value
      if (!entry) return false
      callbacks.delete(entry[0])
      entry[1]()
      return true
    },
    size: () => callbacks.size,
  }
}

/** A timer queue whose callbacks fire only when `fire` is called. */
function makeTimerQueue() {
  const callbacks = new Map<number, () => void>()
  let nextHandle = 1
  return {
    set: (callback: () => void) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    clear: (handle: number) => {
      callbacks.delete(handle)
    },
    fire: () => {
      const entry = callbacks.entries().next().value
      if (!entry) return false
      callbacks.delete(entry[0])
      entry[1]()
      return true
    },
    size: () => callbacks.size,
  }
}

describe("nextRevealGateState", () => {
  const open = (sessionKey: string) => nextRevealGateState(undefined, { type: "session", sessionKey })
  const reduce = (state: RevealGateState, events: RevealGateEvent[], opts?: RevealGateOptions) =>
    events.reduce((acc, event) => nextRevealGateState(acc, event, opts), state)
  const inactive = (n: number): RevealGateEvent[] =>
    Array.from({ length: n }, () => ({ type: "frame", reconcilerActive: false }))
  // Drive session "a" all the way to revealed via the normal settle path.
  const revealedA = () => reduce(open("a"), [{ type: "ready", ready: true }, ...inactive(2)])

  test("a freshly opened session starts covered while loading", () => {
    const state = open("a")
    expect(state.phase).toBe("loading")
    expect(revealGateCovered(state)).toBe(true)
  })

  test("stays covered and loading while messages are not ready, even across frames", () => {
    const state = reduce(open("a"), [
      { type: "ready", ready: false },
      { type: "frame", reconcilerActive: false },
    ])
    expect(state.phase).toBe("loading")
    expect(revealGateCovered(state)).toBe(true)
  })

  test("enters settling (still covered) once messages are ready", () => {
    const state = reduce(open("a"), [{ type: "ready", ready: true }])
    expect(state.phase).toBe("settling")
    expect(revealGateCovered(state)).toBe(true)
  })

  test("reveals after the configured number of consecutive inactive frames once ready", () => {
    const opts: RevealGateOptions = { settleFrames: 2 }
    const ready = reduce(open("a"), [{ type: "ready", ready: true }], opts)
    const afterOne = reduce(ready, inactive(1), opts)
    expect(revealGateCovered(afterOne)).toBe(true)
    const afterTwo = reduce(ready, inactive(2), opts)
    expect(afterTwo.phase).toBe("revealed")
    expect(revealGateCovered(afterTwo)).toBe(false)
  })

  test("an active reconcile frame resets the stable-frame count", () => {
    const opts: RevealGateOptions = { settleFrames: 2 }
    const state = reduce(
      open("a"),
      [
        { type: "ready", ready: true },
        { type: "frame", reconcilerActive: false },
        { type: "frame", reconcilerActive: true },
        { type: "frame", reconcilerActive: false },
      ],
      opts,
    )
    // Only one inactive frame since the last active one — not yet settled.
    expect(revealGateCovered(state)).toBe(true)
  })

  test("an active reconcile frame at zero stable frames keeps the same state object", () => {
    // While the reconciler stays busy the gate sits in settling with stableFrames
    // already 0; re-deriving an identical object every frame would churn the
    // downstream signal for nothing.
    const settling = reduce(open("a"), [{ type: "ready", ready: true }])
    expect(settling.stableFrames).toBe(0)
    const after = nextRevealGateState(settling, { type: "frame", reconcilerActive: true })
    expect(after).toBe(settling)
  })

  test("timeout reveals once ready even if the reconciler never goes quiet", () => {
    const settled = reduce(open("a"), [
      { type: "ready", ready: true },
      { type: "frame", reconcilerActive: true },
      { type: "timeout" },
    ])
    expect(settled.phase).toBe("revealed")
  })

  test("timeout while still loading does not reveal a not-yet-ready session", () => {
    const state = reduce(open("a"), [{ type: "ready", ready: false }, { type: "timeout" }])
    expect(state.phase).toBe("loading")
    expect(revealGateCovered(state)).toBe(true)
  })

  test("switching to a new session re-covers and restarts loading", () => {
    const revealed = revealedA()
    expect(revealed.phase).toBe("revealed")
    const next = nextRevealGateState(revealed, { type: "session", sessionKey: "b" })
    expect(next.sessionKey).toBe("b")
    expect(next.phase).toBe("loading")
    expect(revealGateCovered(next)).toBe(true)
  })

  test("re-emitting the same session key does not re-cover an already revealed timeline", () => {
    const revealed = revealedA()
    const same = nextRevealGateState(revealed, { type: "session", sessionKey: "a" })
    expect(same.phase).toBe("revealed")
    expect(revealGateCovered(same)).toBe(false)
  })

  test("once revealed, later ready/frame/timeout events keep it revealed", () => {
    const revealed = revealedA()
    const after = reduce(revealed, [
      { type: "ready", ready: false },
      { type: "frame", reconcilerActive: true },
      { type: "timeout" },
    ])
    expect(after.phase).toBe("revealed")
  })
})

describe("createRevealGateMachine", () => {
  const makeMachine = (over?: { settleFrames?: number; timeoutMs?: number }) => {
    const frames = makeFrameQueue()
    const timers = makeTimerQueue()
    let active = false
    let ready = false
    const machine = createRevealGateMachine({
      settleFrames: over?.settleFrames ?? 2,
      timeoutMs: over?.timeoutMs ?? 400,
      ready: () => ready,
      reconcilerActive: () => active,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })
    return {
      machine,
      frames,
      timers,
      setActive: (value: boolean) => {
        active = value
      },
      setReady: (value: boolean) => {
        ready = value
      },
      covered: () => revealGateCovered(machine.state()),
    }
  }

  test("lifts the cover after the reconciler stays quiet for settleFrames", () => {
    const ctx = makeMachine({ settleFrames: 2 })
    ctx.machine.session("a")
    expect(ctx.covered()).toBe(true) // loading
    expect(ctx.frames.size()).toBe(0)

    ctx.setReady(true)
    ctx.machine.notifyReady() // → settling, arms the loop + failsafe timer
    expect(ctx.covered()).toBe(true)
    expect(ctx.frames.size()).toBe(1)
    expect(ctx.timers.size()).toBe(1)

    ctx.frames.step() // 1 quiet frame
    expect(ctx.covered()).toBe(true)

    ctx.frames.step() // 2nd quiet frame → reveal; loop stops, timer cleared
    expect(ctx.covered()).toBe(false)
    expect(ctx.frames.size()).toBe(0)
    expect(ctx.timers.size()).toBe(0)
  })

  test("keeps the cover while the reconciler is active, then lifts once it goes quiet", () => {
    const ctx = makeMachine({ settleFrames: 2 })
    ctx.machine.session("a")
    ctx.setReady(true)
    ctx.machine.notifyReady()

    ctx.setActive(true)
    ctx.frames.step()
    ctx.frames.step()
    expect(ctx.covered()).toBe(true) // never quiet → never settles

    ctx.setActive(false)
    ctx.frames.step()
    ctx.frames.step()
    expect(ctx.covered()).toBe(false)
  })

  test("the failsafe timer lifts the cover even if the reconciler never goes quiet", () => {
    const ctx = makeMachine({ settleFrames: 2 })
    ctx.machine.session("a")
    ctx.setReady(true)
    ctx.machine.notifyReady()
    ctx.setActive(true)
    ctx.frames.step() // stays settling
    expect(ctx.covered()).toBe(true)

    ctx.timers.fire() // failsafe → reveal
    expect(ctx.covered()).toBe(false)
    expect(ctx.frames.size()).toBe(0)
  })

  test("switching sessions re-covers and re-arms the settle watch when already ready", () => {
    const ctx = makeMachine({ settleFrames: 2 })
    ctx.machine.session("a")
    ctx.setReady(true)
    ctx.machine.notifyReady()
    ctx.frames.step()
    ctx.frames.step()
    expect(ctx.covered()).toBe(false) // session a revealed

    ctx.machine.session("b") // ready stays true across a same-scope switch
    expect(ctx.covered()).toBe(true) // re-covered
    expect(ctx.frames.size()).toBe(1) // settle watch re-armed for b
  })
})
