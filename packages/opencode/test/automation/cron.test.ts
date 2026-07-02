import { describe, expect, test } from "bun:test"
import { isValidCronExpression as cronIsValid, parseCronSchedule } from "../../src/automation/cron"
import { nextCronFireAfter } from "../../src/automation/derived"
import { Automation } from "../../src/automation"

describe("automation cron validation — single source of truth", () => {
  const cases: Array<[string, boolean]> = [
    ["* * * * *", true],
    ["0 0 1 * *", true],
    ["0 0 1-5 * *", true],
    ["*/15 * * * *", true],
    ["0 0 * * 1-5", true],
    ["0 0 31 2 1", true],
    ["0 0 31 2 *", false],
    ["0 0 30 2 *", false],
    ["60 * * * *", false],
    ["* 24 * * *", false],
    ["* * 0 * *", false],
    ["* * 32 * *", false],
    ["* * * 0 *", false],
    ["* * * 13 *", false],
    ["* * * * 8", false],
    ["bad", false],
    ["* * * *", false],
    ["* * * * * *", false],
    ["5-3 * * * *", false],
  ]

  test("Automation.isValidCronExpression delegates to cron module", () => {
    for (const [expr, expected] of cases) {
      expect(Automation.isValidCronExpression(expr)).toBe(expected)
      expect(cronIsValid(expr)).toBe(expected)
    }
  })

  // Vixie rule the automate tool's recurring description documents: when BOTH
  // day-of-month and day-of-week are restricted, either match fires. A one-shot
  // pinned to a date must keep day-of-week as * or it fires prematurely.
  test("restricted day-of-month and day-of-week match as OR", () => {
    const from = Date.UTC(2026, 11, 1) // 2026-12-01, a Tuesday
    const pinnedDate = nextCronFireAfter("0 15 24 12 *", "UTC", from)
    expect(pinnedDate).toBe(Date.UTC(2026, 11, 24, 15, 0)) // Dec 24, as intended
    const withWeekday = nextCronFireAfter("0 15 24 12 1", "UTC", from)
    expect(withWeekday).toBe(Date.UTC(2026, 11, 7, 15, 0)) // first Monday — fires 17 days early
  })

  test("valid expressions parse without throwing; invalid ones either throw or fail reachability", () => {
    for (const [expr, expected] of cases) {
      if (expected) {
        expect(() => parseCronSchedule(expr)).not.toThrow()
      } else {
        let threw = false
        try {
          parseCronSchedule(expr)
        } catch {
          threw = true
        }
        const reachable = !threw && cronIsValid(expr)
        expect(threw || !reachable).toBe(true)
      }
    }
  })
})
