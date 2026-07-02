import { describe, expect, test } from "bun:test"
import type { AutomationDefinition, AutomationRhythm } from "@opencode-ai/sdk/v2/client"
import { scheduleDraftFromDefinition } from "./automation-schedule-form"

const recurring = (rhythm: AutomationRhythm): AutomationDefinition =>
  ({ kind: "recurring", rhythm }) as AutomationDefinition

const oneshot = (fireAt: number, timezone: string): AutomationDefinition =>
  ({ kind: "oneshot", fireAt, timezone }) as AutomationDefinition

describe("scheduleDraftFromDefinition", () => {
  test("daily cron round-trips", () => {
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "5 9 * * *" }))).toEqual({
      frequency: "daily",
      hour: 9,
      minute: 5,
      weekday: 1,
    })
  })

  test("weekdays cron round-trips", () => {
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "0 18 * * 1-5" }))).toEqual({
      frequency: "weekdays",
      hour: 18,
      minute: 0,
      weekday: 1,
    })
  })

  test("weekly cron keeps the weekday", () => {
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "30 8 * * 0" }))).toEqual({
      frequency: "weekly",
      hour: 8,
      minute: 30,
      weekday: 0,
    })
  })

  test("oneshot maps fireAt to local time in the definition timezone", () => {
    // 2026-06-12T09:00 in Asia/Shanghai = 2026-06-12T01:00 UTC.
    const fireAt = Date.UTC(2026, 5, 12, 1, 0)
    expect(scheduleDraftFromDefinition(oneshot(fireAt, "Asia/Shanghai"))).toEqual({
      frequency: "once",
      hour: 9,
      minute: 0,
      weekday: 1,
    })
  })

  test("arbitrary cron does not map", () => {
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "0 * * * *" }))).toBeUndefined()
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "*/15 * * * *" }))).toBeUndefined()
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "0 9 1 * *" }))).toBeUndefined()
    expect(scheduleDraftFromDefinition(recurring({ kind: "cron", expression: "99 9 * * *" }))).toBeUndefined()
  })

  test("interval rhythm does not map", () => {
    expect(scheduleDraftFromDefinition(recurring({ kind: "interval", everyMs: 3600000 }))).toBeUndefined()
  })
})
