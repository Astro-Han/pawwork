import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PerfBaselineComparison, PerfProfile, PerfScenarioSummary } from "./perf-metrics"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function scenario(input: {
  branch: string
  profile?: PerfProfile
  scenario?: string
  interaction?: number
  frameMax?: number
}): PerfScenarioSummary {
  const interaction = input.interaction ?? 40
  return {
    branch: input.branch,
    profile: input.profile ?? "default",
    scenario: input.scenario ?? "session-scroll-reading",
    runs: 3,
    interaction_ms_median: interaction,
    interaction_ms_worst: interaction,
    interaction_ms: interaction,
    interaction_delay_ms: 0,
    long_task_count: 0,
    long_task_max_ms: 0,
    tbt_ms: 0,
    frame_gap_p95_ms: 16,
    frame_gap_max_ms: input.frameMax ?? 16,
    jank_count_50ms: 0,
    cls: 0,
    window_ms: 900,
    run_details: [],
  }
}

async function writeJson(filePath: string, payload: unknown) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

describe("compare-perf script", () => {
  test("confirms only the initial metric failure key from failures-from", async () => {
    const root = await mkdtemp(join(tmpdir(), "compare-perf-script-"))
    tempRoots.push(root)
    const basePath = join(root, "base.json")
    const headPath = join(root, "head.json")
    const initialPath = join(root, "perf-compare.json")
    const outputPath = join(root, "perf-compare-confirm.json")
    const initialComparison: PerfBaselineComparison = {
      pass: false,
      failures: ["default:session-scroll-reading:interaction_ms_median"],
      warnings: [],
      scenarios: [
        {
          profile: "default",
          scenario: "session-scroll-reading",
          pass: false,
          failures: ["interaction_ms_median"],
          warnings: [],
          base: scenario({ branch: "base", interaction: 48 }),
          head: scenario({ branch: "head", interaction: 76 }),
        },
      ],
    }

    await writeJson(basePath, [scenario({ branch: "base", interaction: 32, frameMax: 16 })])
    await writeJson(headPath, [scenario({ branch: "head", interaction: 40, frameMax: 120 })])
    await writeJson(initialPath, initialComparison)

    const child = Bun.spawn(
      [
        process.execPath,
        "script/compare-perf.ts",
        "--base",
        basePath,
        "--head",
        headPath,
        "--output",
        outputPath,
        "--failures-from",
        initialPath,
      ],
      {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const summary = JSON.parse(stdout) as Pick<PerfBaselineComparison, "confirmation" | "failures" | "pass">
    expect(summary.pass).toBe(true)
    expect(summary.failures).toHaveLength(0)
    expect(summary.confirmation).toEqual({
      initialFailureKeys: ["default:session-scroll-reading:interaction_ms_median"],
      rawConfirmedFailures: ["default:session-scroll-reading:frame_gap_max_ms_delta"],
      intersectedFailures: [],
    })
    const comparison = JSON.parse(await readFile(outputPath, "utf8")) as PerfBaselineComparison
    expect(comparison.pass).toBe(true)
    expect(comparison.failures).toHaveLength(0)
    expect(comparison.confirmation).toEqual({
      initialFailureKeys: ["default:session-scroll-reading:interaction_ms_median"],
      rawConfirmedFailures: ["default:session-scroll-reading:frame_gap_max_ms_delta"],
      intersectedFailures: [],
    })
  })

  test("keeps top-level missing scenario failures in the confirmation scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "compare-perf-script-"))
    tempRoots.push(root)
    const basePath = join(root, "base.json")
    const headPath = join(root, "head.json")
    const initialPath = join(root, "perf-compare.json")
    const outputPath = join(root, "perf-compare-confirm.json")
    const initialComparison: PerfBaselineComparison = {
      pass: false,
      failures: ["missing_head_scenario:default:session-scroll-reading"],
      warnings: [],
      scenarios: [],
    }

    await writeJson(basePath, [scenario({ branch: "base" })])
    await writeJson(headPath, [])
    await writeJson(initialPath, initialComparison)

    const child = Bun.spawn(
      [
        process.execPath,
        "script/compare-perf.ts",
        "--base",
        basePath,
        "--head",
        headPath,
        "--output",
        outputPath,
        "--failures-from",
        initialPath,
      ],
      {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(1)
    const summary = JSON.parse(stdout) as Pick<PerfBaselineComparison, "failures" | "pass">
    expect(summary.pass).toBe(false)
    expect(summary.failures).toEqual(["missing_head_scenario:default:session-scroll-reading"])
    const comparison = JSON.parse(await readFile(outputPath, "utf8")) as PerfBaselineComparison
    expect(comparison.pass).toBe(false)
    expect(comparison.failures).toEqual(["missing_head_scenario:default:session-scroll-reading"])
  })
})
