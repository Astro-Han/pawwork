import { expect, test } from "bun:test"
import { shouldRunScenario, type PerfScenarioName } from "./profiles"

test("default profile runs heavy default-open bash perf coverage", () => {
  const scenario = "tool-default-open-heavy-bash" as PerfScenarioName

  expect(shouldRunScenario("default", scenario)).toBe(true)
  expect(shouldRunScenario("low-end", scenario)).toBe(false)
})

test("default profile runs long-session input lag coverage", () => {
  const scenario = "long-session-input-lag" as PerfScenarioName

  expect(shouldRunScenario("default", scenario)).toBe(true)
  expect(shouldRunScenario("low-end", scenario)).toBe(false)
})

test("low-end profile runs long scroll reading coverage", () => {
  const scenario = "session-scroll-reading-long" as PerfScenarioName

  expect(shouldRunScenario("default", scenario)).toBe(false)
  expect(shouldRunScenario("low-end", scenario)).toBe(true)
})
