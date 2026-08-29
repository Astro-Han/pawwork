import type { UpdateResult } from "./updater"

// Periodic silent update checks. The updater controller is the authority on
// what a check does; this scheduler only decides WHEN one happens: once when
// the product UI is up (the wiring calls start() on product-ready), then every
// interval. Polling stops for good once an update is downloaded — a latched
// ready update makes further checks pointless until the install's restart
// begins a fresh process and a fresh schedule.
//
// The next check is chained after the previous one settles rather than run on
// a fixed interval: a check has no cancellation and can outlive the interval
// on a slow network, and overlapping checks would collapse into the
// controller's busy answer anyway. Injected timers keep the 4-hour cadence
// testable without fake-timer global surgery.

type Deps = {
  check: () => Promise<UpdateResult>
  intervalMs: number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export function createUpdateScheduler(deps: Deps) {
  let running = false
  let timer: unknown

  const scheduleNext = () => {
    timer = deps.setTimer(() => void cycle(), deps.intervalMs)
  }

  const cycle = async () => {
    // A rejecting check is a failed check for scheduling purposes: the chain
    // must survive it, or one bad network blip would end all future checks.
    const result = await deps.check().catch(() => ({ status: "failed" }) as UpdateResult)
    if (!running) return
    if (result.status === "ready") {
      running = false
      return
    }
    scheduleNext()
  }

  return {
    start() {
      if (running) return
      running = true
      void cycle()
    },
    stop() {
      running = false
      if (timer !== undefined) deps.clearTimer(timer)
      timer = undefined
    },
  }
}
