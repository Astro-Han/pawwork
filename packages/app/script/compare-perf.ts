import fs from "node:fs/promises"
import path from "node:path"
import {
  comparePerfBaselines,
  renderPerfBaselineComment,
  type PerfBaselineComparison,
  type PerfScenarioSummary,
} from "../src/testing/perf-metrics"

function readArg(flag: string) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) return undefined
  return value
}

async function readPerfFile(filePath: string) {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as PerfScenarioSummary[]
  if (!Array.isArray(payload)) {
    throw new Error(`Expected an array of perf scenarios in ${filePath}`)
  }
  return payload
}

async function readFailureScenarioKeys(filePath: string) {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as PerfBaselineComparison
  if (!Array.isArray(payload.scenarios)) {
    throw new Error(`Expected a perf comparison with scenarios in ${filePath}`)
  }
  return payload.scenarios
    .filter((scenario) => scenario.failures.length > 0)
    .map((scenario) => `${scenario.profile}:${scenario.scenario}`)
}

async function main() {
  const basePath = readArg("--base")
  const headPath = readArg("--head")
  const outputPath = readArg("--output")
  const commentOutputPath = readArg("--comment-output")
  const failuresFromPath = readArg("--failures-from")

  if (!basePath || !headPath) {
    throw new Error(
      "Usage: bun script/compare-perf.ts --base <perf-base.json> --head <perf-head.json> [--output <path>]",
    )
  }

  const [base, head, scenarioKeys] = await Promise.all([
    readPerfFile(basePath),
    readPerfFile(headPath),
    failuresFromPath ? readFailureScenarioKeys(failuresFromPath) : undefined,
  ])
  const comparison = comparePerfBaselines({ base, head, scenarioKeys })

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${JSON.stringify(comparison, null, 2)}\n`)
  }
  if (commentOutputPath) {
    await fs.mkdir(path.dirname(commentOutputPath), { recursive: true })
    await fs.writeFile(commentOutputPath, renderPerfBaselineComment(comparison))
  }

  const summary = {
    pass: comparison.pass,
    failures: comparison.failures,
    warnings: comparison.warnings,
  }
  console.log(JSON.stringify(summary, null, 2))

  if (!comparison.pass) {
    process.exitCode = 1
  }
}

await main()
