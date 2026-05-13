import { describe, expect, test } from "bun:test"
import { planFlushSchedule } from "./global-sdk"

describe("global SDK flush scheduling", () => {
  test("delta events use a 30fps cadence budget", () => {
    const plan = planFlushSchedule({
      now: 1_000,
      lastFlushAt: 980,
      frameMs: 33,
    })

    expect(plan).toEqual({ delayMs: 13, dueAt: 1_013 })
  })

  test("delta events flush immediately once the cadence budget is already spent", () => {
    const plan = planFlushSchedule({
      now: 1_000,
      lastFlushAt: 960,
      frameMs: 33,
    })

    expect(plan).toEqual({ delayMs: 0, dueAt: 1_000 })
  })

  test("non-delta events can pull an existing delta timer earlier", () => {
    const next = planFlushSchedule({
      now: 1_000,
      lastFlushAt: 992,
      frameMs: 16,
      scheduledDueAt: 1_025,
    })

    expect(next).toEqual({ delayMs: 8, dueAt: 1_008 })
  })

  test("delta events do not widen an earlier non-delta timer", () => {
    const next = planFlushSchedule({
      now: 1_000,
      lastFlushAt: 992,
      frameMs: 33,
      scheduledDueAt: 1_008,
    })

    expect(next).toEqual({ delayMs: 8, dueAt: 1_008 })
  })
})
