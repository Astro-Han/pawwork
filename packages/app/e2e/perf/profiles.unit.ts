import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

test("low-end profile gates concurrent-shimmer-extreme guard", () => {
  const scenario = "concurrent-shimmer-extreme" as PerfScenarioName

  expect(shouldRunScenario("default", scenario)).toBe(false)
  expect(shouldRunScenario("low-end", scenario)).toBe(true)
})

describe("PAWWORK_PERF_SCENARIOS env filter", () => {
  const previous = process.env.PAWWORK_PERF_SCENARIOS

  beforeEach(() => {
    delete process.env.PAWWORK_PERF_SCENARIOS
  })

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.PAWWORK_PERF_SCENARIOS
    } else {
      process.env.PAWWORK_PERF_SCENARIOS = previous
    }
  })

  test("absent env keeps profile membership as the only gate", () => {
    expect(shouldRunScenario("default", "homepage-cold" as PerfScenarioName)).toBe(true)
    expect(shouldRunScenario("low-end", "concurrent-shimmer-extreme" as PerfScenarioName)).toBe(true)
  })

  test("env filter restricts to the listed scenarios within a profile", () => {
    process.env.PAWWORK_PERF_SCENARIOS = "homepage-cold,long-session-input-lag"

    expect(shouldRunScenario("default", "homepage-cold" as PerfScenarioName)).toBe(true)
    expect(shouldRunScenario("default", "long-session-input-lag" as PerfScenarioName)).toBe(true)
    expect(shouldRunScenario("default", "tool-call-expand" as PerfScenarioName)).toBe(false)
  })

  test("env filter does not lift profile membership", () => {
    process.env.PAWWORK_PERF_SCENARIOS = "concurrent-shimmer-extreme"

    expect(shouldRunScenario("default", "concurrent-shimmer-extreme" as PerfScenarioName)).toBe(false)
    expect(shouldRunScenario("low-end", "concurrent-shimmer-extreme" as PerfScenarioName)).toBe(true)
  })

  test("empty env is treated as no filter", () => {
    process.env.PAWWORK_PERF_SCENARIOS = ""

    expect(shouldRunScenario("default", "homepage-cold" as PerfScenarioName)).toBe(true)
  })

  test("whitespace and empty entries are tolerated", () => {
    process.env.PAWWORK_PERF_SCENARIOS = " homepage-cold , , long-session-input-lag "

    expect(shouldRunScenario("default", "homepage-cold" as PerfScenarioName)).toBe(true)
    expect(shouldRunScenario("default", "long-session-input-lag" as PerfScenarioName)).toBe(true)
    expect(shouldRunScenario("default", "tool-call-expand" as PerfScenarioName)).toBe(false)
  })
})
