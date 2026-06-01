import { describe, expect, test } from "bun:test"
import { isValidCronExpression as cronIsValid, parseCronSchedule } from "../../src/automation/cron"
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
