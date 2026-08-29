import { describe, expect, test } from "vitest"
import { createUpdateScheduler } from "./updater-scheduler"
import type { UpdateResult } from "./updater"

// Let an async check and its chained continuation fully settle.
const flush = () => new Promise((resolve) => setImmediate(resolve))

function harness(check: () => Promise<UpdateResult>) {
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = []
  const scheduler = createUpdateScheduler({
    check,
    intervalMs: 4 * 60 * 60 * 1000,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
  })
  return {
    scheduler,
    timers,
    // Fire the oldest live timer.
    tick() {
      const timer = timers.find((candidate) => !candidate.cancelled)
      if (!timer) throw new Error("no scheduled check to fire")
      timer.cancelled = true
      timer.callback()
    },
    liveCount: () => timers.filter((candidate) => !candidate.cancelled).length,
  }
}

describe("update scheduler", () => {
  test("checks as soon as it starts", async () => {
    let checks = 0
    const { scheduler } = harness(async () => {
      checks += 1
      return { status: "none" }
    })
    scheduler.start()
    await flush()
    expect(checks).toBe(1)
    scheduler.stop()
  })

  test("checks again after the interval while no update is ready", async () => {
    let checks = 0
    const { scheduler, tick } = harness(async () => {
      checks += 1
      return { status: "none" }
    })
    scheduler.start()
    await flush()
    tick()
    await flush()
    tick()
    await flush()
    expect(checks).toBe(3)
    scheduler.stop()
  })

  test("keeps polling after a failed check", async () => {
    let checks = 0
    const { scheduler, tick } = harness(async () => {
      checks += 1
      return { status: "failed", reason: "check", message: "offline" }
    })
    scheduler.start()
    await flush()
    tick()
    await flush()
    expect(checks).toBe(2)
    scheduler.stop()
  })

  test("keeps polling when the check itself throws", async () => {
    let checks = 0
    const { scheduler, tick } = harness(async () => {
      checks += 1
      throw new Error("unexpected")
    })
    scheduler.start()
    await flush()
    await flush()
    tick()
    await flush()
    await flush()
    expect(checks).toBe(2)
    scheduler.stop()
  })

  test("stops polling once an update is downloaded", async () => {
    const { scheduler, tick, liveCount } = harness(async () => ({ status: "ready", version: "0.2.5" }))
    scheduler.start()
    await flush()
    expect(liveCount()).toBe(0)
    expect(tick).toThrow()
    scheduler.stop()
  })

  test("waits for a slow check before scheduling the next one", async () => {
    let resolveCheck: (result: UpdateResult) => void = () => {}
    const { scheduler, liveCount } = harness(
      () =>
        new Promise<UpdateResult>((resolve) => {
          resolveCheck = resolve
        }),
    )
    scheduler.start()
    await flush()
    expect(liveCount()).toBe(0)
    resolveCheck({ status: "none" })
    await flush()
    expect(liveCount()).toBe(1)
    scheduler.stop()
  })

  test("a cycle orphaned by stop+start cannot schedule a second chain", async () => {
    // stop() clears the pending timer but not an in-flight check; a start()
    // during that window must retire the old cycle before it schedules again,
    // or two timer chains run side by side and only the newest is stoppable.
    const resolvers: Array<(result: UpdateResult) => void> = []
    const { scheduler, liveCount } = harness(
      () =>
        new Promise<UpdateResult>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    scheduler.start()
    await flush()
    scheduler.stop()
    scheduler.start()
    await flush()
    expect(resolvers).toHaveLength(2)
    resolvers[0]({ status: "none" })
    await flush()
    // The orphaned cycle must retire silently: nothing scheduled yet, and the
    // still in-flight restart cycle has not resolved. Pre-fix this was 1.
    expect(liveCount()).toBe(0)
    resolvers[1]({ status: "none" })
    await flush()
    expect(liveCount()).toBe(1)
    scheduler.stop()
  })

  test("stop prevents the scheduled check from running", async () => {
    let checks = 0
    const { scheduler, tick } = harness(async () => {
      checks += 1
      return { status: "none" }
    })
    scheduler.start()
    await flush()
    scheduler.stop()
    expect(() => tick()).toThrow()
    expect(checks).toBe(1)
  })

  test("starting twice does not double-schedule", async () => {
    let checks = 0
    const { scheduler, liveCount } = harness(async () => {
      checks += 1
      return { status: "none" }
    })
    scheduler.start()
    scheduler.start()
    await flush()
    expect(checks).toBe(1)
    expect(liveCount()).toBe(1)
    scheduler.stop()
  })
})
