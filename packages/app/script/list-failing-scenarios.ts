import fs from "node:fs/promises"
import type { PerfBaselineComparison } from "../src/testing/perf-metrics"

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: bun script/list-failing-scenarios.ts <perf-compare.json>")
  }

  const payload = JSON.parse(await fs.readFile(inputPath, "utf8")) as PerfBaselineComparison
  const failingByProfile = new Map<"default" | "low_end", string[]>([
    ["default", []],
    ["low_end", []],
  ])

  for (const scenario of payload.scenarios) {
    if (scenario.failures.length === 0) continue
    const key = scenario.profile === "low-end" ? "low_end" : "default"
    failingByProfile.get(key)!.push(scenario.scenario)
  }

  for (const [key, names] of failingByProfile) {
    process.stdout.write(`${key}=${names.join(",")}\n`)
  }
}

await main()
