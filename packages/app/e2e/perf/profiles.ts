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

const defaultScenarios = new Set<PerfScenarioName>([
  "homepage-cold",
  "long-session-input-lag",
  "session-streaming-long",
  "tool-call-expand",
  "tool-default-open-heavy-bash",
  "terminal-side-panel-open",
  "session-scroll-reading",
])

const lowEndScenarios = new Set<PerfScenarioName>(["session-scroll-reading-long", "session-timeline-recompute"])

export function readPerfProfile(): PerfProfile {
  return process.env.PAWWORK_PERF_PROFILE === "low-end" ? "low-end" : "default"
}

export function shouldRunScenario(profile: PerfProfile, scenario: PerfScenarioName) {
  return profile === "low-end" ? lowEndScenarios.has(scenario) : defaultScenarios.has(scenario)
}

export async function applyPerfProfile(page: Page, profile: PerfProfile) {
  if (profile !== "low-end") return
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 })
}
