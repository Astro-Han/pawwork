import { describe, expect, test } from "bun:test"
import type { AutomationDefinition, AutomationRhythm } from "@opencode-ai/sdk/v2/client"
import { formatScheduleSummary } from "./automation-schedule"

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key)

const recurring = (rhythm: AutomationRhythm): AutomationDefinition =>
  ({ kind: "recurring", rhythm }) as AutomationDefinition

const oneshot = (): AutomationDefinition => ({ kind: "oneshot" }) as AutomationDefinition

describe("formatScheduleSummary", () => {
  test("oneshot", () => {
    expect(formatScheduleSummary(oneshot(), t)).toBe("automations.schedule.once")
  })

  test("hourly cron", () => {
    expect(formatScheduleSummary(recurring({ kind: "cron", expression: "0 * * * *" }), t)).toBe("automations.schedule.hourly")
  })

  test("daily cron with time", () => {
    expect(formatScheduleSummary(recurring({ kind: "cron", expression: "5 9 * * *" }), t)).toBe(
      'automations.schedule.daily:{"time":"09:05"}',
    )
  })

  test("weekdays cron", () => {
    expect(formatScheduleSummary(recurring({ kind: "cron", expression: "0 9 * * 1-5" }), t)).toBe(
      'automations.schedule.weekdays:{"time":"09:00"}',
    )
  })

  test("weekly cron", () => {
    expect(formatScheduleSummary(recurring({ kind: "cron", expression: "30 8 * * 0" }), t)).toBe(
      'automations.schedule.weekly:{"time":"08:30"}',
    )
  })

  test("non-standard cron falls back to custom", () => {
    expect(formatScheduleSummary(recurring({ kind: "cron", expression: "0 9 1 * *" }), t)).toBe("automations.schedule.custom")
    expect(formatScheduleSummary(recurring({ kind: "cron", expression: "*/15 * * * *" }), t)).toBe("automations.schedule.hourly")
  })

  test("interval in minutes and hours", () => {
    expect(formatScheduleSummary(recurring({ kind: "interval", everyMs: 30 * 60000 }), t)).toBe(
      'automations.schedule.every:{"duration":"automations.schedule.minutes:{\\"count\\":30}"}',
    )
    expect(formatScheduleSummary(recurring({ kind: "interval", everyMs: 2 * 3600000 }), t)).toBe(
      'automations.schedule.every:{"duration":"automations.schedule.hours:{\\"count\\":2}"}',
    )
  })
})
