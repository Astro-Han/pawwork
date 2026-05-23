import fs from "node:fs/promises"
import path from "node:path"
import {
  comparePerfBaselines,
  perfFailureKey,
  renderPerfBaselineComment,
  type PerfBaselineComparison,
  type PerfFailureKey,
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

async function readFailureScope(filePath: string): Promise<{ scenarioKeys: string[]; failureKeys: PerfFailureKey[] }> {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as PerfBaselineComparison
  if (!Array.isArray(payload.scenarios)) {
    throw new Error(`Expected a perf comparison with scenarios in ${filePath}`)
  }
  const scenarioKeys = new Set<string>()
  const failureKeys = new Set<PerfFailureKey>()

  for (const scenario of payload.scenarios) {
    if (scenario.failures.length === 0) continue
    scenarioKeys.add(`${scenario.profile}:${scenario.scenario}`)
    for (const failure of scenario.failures) {
      failureKeys.add(perfFailureKey({ profile: scenario.profile, scenario: scenario.scenario, metric: failure }))
    }
  }

  return {
    scenarioKeys: [...scenarioKeys],
    failureKeys: [...failureKeys],
  }
}

async function inferFailureScenarioSource(input: { outputPath?: string; failuresFromPath?: string }) {
  if (input.failuresFromPath) return input.failuresFromPath
  if (!input.outputPath || path.basename(input.outputPath) !== "perf-compare-confirm.json") return undefined
  const candidate = path.join(path.dirname(input.outputPath), "perf-compare.json")
  try {
    await fs.access(candidate)
    return candidate
  } catch {
    return undefined
  }
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

  const failuresSourcePath = await inferFailureScenarioSource({ outputPath, failuresFromPath })
  const [base, head, failureScope] = await Promise.all([
    readPerfFile(basePath),
    readPerfFile(headPath),
    failuresSourcePath ? readFailureScope(failuresSourcePath) : undefined,
  ])
  const comparison = comparePerfBaselines({
    base,
    head,
    scenarioKeys: failureScope?.scenarioKeys,
    failureKeys: failureScope?.failureKeys,
  })

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
    confirmation: comparison.confirmation,
  }
  console.log(JSON.stringify(summary, null, 2))

  if (!comparison.pass) {
    process.exitCode = 1
  }
}

await main()
