import fs from "node:fs/promises"
import type { PerfBaselineComparison } from "../src/testing/perf-metrics"

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: bun script/list-failing-scenarios.ts <perf-compare.json>")
  }

  const failingByProfile = new Map<"default" | "low_end", string[]>([
    ["default", []],
    ["low_end", []],
  ])

  try {
    const payload = JSON.parse(await fs.readFile(inputPath, "utf8")) as PerfBaselineComparison
    for (const scenario of payload.scenarios) {
      if (scenario.failures.length === 0) continue
      const key = scenario.profile === "low-end" ? "low_end" : "default"
      failingByProfile.get(key)!.push(scenario.scenario)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`::warning::Failed to read failing scenarios from ${inputPath}: ${message}\n`)
  }

  const output = Array.from(failingByProfile, ([key, names]) => `${key}=${names.join(",")}`).join("\n") + "\n"
  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    await fs.appendFile(githubOutput, output)
  } else {
    process.stdout.write(output)
  }
}

await main()
