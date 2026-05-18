import type { Page } from "@playwright/test"
import type { PerfProfile } from "../../src/testing/perf-metrics"

export type PerfScenarioName =
  | "homepage-cold"
  | "long-session-input-lag"
  | "session-streaming-long"
  | "tool-call-expand"
  | "tool-default-open-heavy-bash"
  | "terminal-side-panel-open"
  | "session-scroll-reading"
  | "session-scroll-reading-long"
  | "session-timeline-recompute"
  | "concurrent-shimmer-extreme"

const defaultScenarios = new Set<PerfScenarioName>([
  "homepage-cold",
  "long-session-input-lag",
  "session-streaming-long",
  "tool-call-expand",
  "tool-default-open-heavy-bash",
  "terminal-side-panel-open",
  "session-scroll-reading",
])

const lowEndScenarios = new Set<PerfScenarioName>([
  "session-scroll-reading-long",
  "session-timeline-recompute",
  "concurrent-shimmer-extreme",
])

export function readPerfProfile(): PerfProfile {
  return process.env.PAWWORK_PERF_PROFILE === "low-end" ? "low-end" : "default"
}

function readScenarioFilter(): ReadonlySet<PerfScenarioName> | null {
  const raw = process.env.PAWWORK_PERF_SCENARIOS
  if (!raw) return null
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0) as PerfScenarioName[]
  if (items.length === 0) return null
  return new Set(items)
}

export function shouldRunScenario(profile: PerfProfile, scenario: PerfScenarioName) {
  const inProfile = profile === "low-end" ? lowEndScenarios.has(scenario) : defaultScenarios.has(scenario)
  if (!inProfile) return false
  const filter = readScenarioFilter()
  if (filter && !filter.has(scenario)) return false
  return true
}

export async function applyPerfProfile(page: Page, profile: PerfProfile) {
  if (profile !== "low-end") return
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 })
}
