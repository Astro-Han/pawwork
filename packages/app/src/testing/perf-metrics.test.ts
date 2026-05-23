import { describe, expect, test } from "bun:test"
import {
  aggregatePerfRuns,
  comparePerfBaselines,
  comparePerfScenarioSummaries,
  PERF_COMMENT_MARKER,
  renderPerfBaselineComment,
  summarizePerfRun,
} from "./perf-metrics"

function scenario(input: {
  branch?: string
  profile?: "default" | "low-end"
  scenario?: string
  interaction?: number
  worst?: number
  longTask?: number
  tbt?: number
  frameP95?: number
  frameMax?: number
  jank?: number
  cls?: number
}) {
  const value = input.interaction ?? 40
  return {
    branch: input.branch ?? "base",
    profile: input.profile ?? "default",
    scenario: input.scenario ?? "homepage-cold",
    runs: 3,
    interaction_ms_median: value,
    interaction_ms_worst: input.worst ?? value,
    interaction_ms: value,
    interaction_delay_ms: 0,
    long_task_count: input.longTask && input.longTask > 0 ? 1 : 0,
    long_task_max_ms: input.longTask ?? 0,
    tbt_ms: input.tbt ?? 0,
    frame_gap_p95_ms: input.frameP95 ?? 16.8,
    frame_gap_max_ms: input.frameMax ?? 16.8,
    jank_count_50ms: input.jank ?? 0,
    cls: input.cls ?? 0,
    window_ms: 900,
    run_details: [],
  }
}

describe("perf metrics", () => {
  test("summarizes a perf sample window", () => {
    const summary = summarizePerfRun({
      startedAt: 100,
      endedAt: 200,
      interactions: [
        { at: 90, delay: 1, duration: 10 },
        { at: 120, delay: 8, duration: 72 },
        { at: 160, delay: 4, duration: 41 },
      ],
      longTasks: [
        { at: 80, duration: 120 },
        { at: 130, duration: 80 },
        { at: 170, duration: 55 },
      ],
      frames: [
        { at: 110, duration: 16 },
        { at: 120, duration: 18 },
        { at: 130, duration: 22 },
        { at: 140, duration: 55 },
        { at: 150, duration: 80 },
      ],
      shifts: [
        { at: 95, value: 0.3 },
        { at: 135, value: 0.01 },
        { at: 165, value: 0.02 },
      ],
      fcpMs: 456.4,
      lcpMs: 789.2,
      heapUsedMb: 123.6,
    })

    expect(summary).toEqual({
      interaction_ms: 72,
      interaction_delay_ms: 8,
      long_task_count: 2,
      long_task_max_ms: 80,
      tbt_ms: 35,
      frame_gap_p95_ms: 80,
      frame_gap_max_ms: 80,
      jank_count_50ms: 2,
      cls: 0.03,
      window_ms: 100,
      fcp_ms: 456.4,
      lcp_ms: 789.2,
      heap_used_mb: 123.6,
    })
  })

  test("aggregates scenario medians and worst interaction", () => {
    const summary = aggregatePerfRuns({
      branch: "dev",
      scenario: "tool-call-expand",
      runs: [
        {
          interaction_ms: 40,
          interaction_delay_ms: 6,
          long_task_count: 1,
          long_task_max_ms: 61,
          tbt_ms: 11,
          frame_gap_p95_ms: 28,
          frame_gap_max_ms: 47,
          jank_count_50ms: 0,
          cls: 0.002,
          window_ms: 1200,
          fcp_ms: undefined,
          lcp_ms: undefined,
          heap_used_mb: 91,
        },
        {
          interaction_ms: 75,
          interaction_delay_ms: 10,
          long_task_count: 2,
          long_task_max_ms: 74,
          tbt_ms: 24,
          frame_gap_p95_ms: 35,
          frame_gap_max_ms: 58,
          jank_count_50ms: 1,
          cls: 0.004,
          window_ms: 1190,
          fcp_ms: undefined,
          lcp_ms: undefined,
          heap_used_mb: 93,
        },
        {
          interaction_ms: 52,
          interaction_delay_ms: 7,
          long_task_count: 1,
          long_task_max_ms: 68,
          tbt_ms: 18,
          frame_gap_p95_ms: 30,
          frame_gap_max_ms: 54,
          jank_count_50ms: 1,
          cls: 0.003,
          window_ms: 1210,
          fcp_ms: undefined,
          lcp_ms: undefined,
          heap_used_mb: 95,
        },
      ],
    })

    expect(summary.branch).toBe("dev")
    expect(summary.profile).toBe("default")
    expect(summary.scenario).toBe("tool-call-expand")
    expect(summary.runs).toBe(3)
    expect(summary.interaction_ms_median).toBe(52)
    expect(summary.interaction_ms_worst).toBe(75)
    expect(summary.long_task_max_ms).toBe(68)
    expect(summary.tbt_ms).toBe(18)
    expect(summary.frame_gap_p95_ms).toBe(30)
    expect(summary.frame_gap_max_ms).toBe(54)
    expect(summary.cls).toBe(0.003)
    expect(summary.heap_used_mb).toBe(93)
    expect(summary.run_details).toHaveLength(3)
  })

  test("does not fail default interaction median on a single-frame delta", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "long-session-input-lag",
      base: scenario({ branch: "base", scenario: "long-session-input-lag", interaction: 48 }),
      head: scenario({ branch: "head", scenario: "long-session-input-lag", interaction: 64 }),
    })

    expect(result.pass).toBe(true)
    expect(result.failures).not.toContain("interaction_ms_median")
  })

  test("keeps default interaction median at the 20ms floor passing", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "long-session-input-lag",
      base: scenario({ branch: "base", scenario: "long-session-input-lag", interaction: 100 }),
      head: scenario({ branch: "head", scenario: "long-session-input-lag", interaction: 120 }),
    })

    expect(result.pass).toBe(true)
    expect(result.failures).not.toContain("interaction_ms_median")
  })

  test("fails default interaction median above the 20ms floor", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "long-session-input-lag",
      base: scenario({ branch: "base", scenario: "long-session-input-lag", interaction: 100 }),
      head: scenario({ branch: "head", scenario: "long-session-input-lag", interaction: 121 }),
    })

    expect(result.pass).toBe(false)
    expect(result.failures).toContain("interaction_ms_median")
  })

  test("fails a scenario when median regression breaks both the ms and percentage budgets", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "session-streaming-long",
      base: {
        branch: "base",
        profile: "default",
        scenario: "session-streaming-long",
        runs: 3,
        interaction_ms_median: 100,
        interaction_ms_worst: 140,
        interaction_ms: 100,
        interaction_delay_ms: 12,
        long_task_count: 1,
        long_task_max_ms: 80,
        tbt_ms: 30,
        frame_gap_p95_ms: 32,
        frame_gap_max_ms: 60,
        jank_count_50ms: 1,
        cls: 0.11,
        window_ms: 1200,
        run_details: [],
      },
      head: {
        branch: "head",
        profile: "default",
        scenario: "session-streaming-long",
        runs: 3,
        interaction_ms_median: 125,
        interaction_ms_worst: 168,
        interaction_ms: 125,
        interaction_delay_ms: 14,
        long_task_count: 1,
        long_task_max_ms: 88,
        tbt_ms: 34,
        frame_gap_p95_ms: 35,
        frame_gap_max_ms: 70,
        jank_count_50ms: 1,
        cls: 0.013,
        window_ms: 1220,
        run_details: [],
      },
    })

    expect(result.pass).toBe(false)
    expect(result.failures).toContain("interaction_ms_median")
    expect(result.warnings).toHaveLength(0)
  })

  test("fails a scenario on catastrophic absolute thresholds even when there is no regression delta", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "tool-call-expand",
      base: {
        branch: "base",
        profile: "default",
        scenario: "tool-call-expand",
        runs: 3,
        interaction_ms_median: 120,
        interaction_ms_worst: 510,
        interaction_ms: 120,
        interaction_delay_ms: 12,
        long_task_count: 1,
        long_task_max_ms: 90,
        tbt_ms: 36,
        frame_gap_p95_ms: 32,
        frame_gap_max_ms: 90,
        jank_count_50ms: 1,
        cls: 0.01,
        window_ms: 900,
        run_details: [],
      },
      head: {
        branch: "head",
        profile: "default",
        scenario: "tool-call-expand",
        runs: 3,
        interaction_ms_median: 120,
        interaction_ms_worst: 510,
        interaction_ms: 120,
        interaction_delay_ms: 12,
        long_task_count: 1,
        long_task_max_ms: 90,
        tbt_ms: 36,
        frame_gap_p95_ms: 32,
        frame_gap_max_ms: 90,
        jank_count_50ms: 1,
        cls: 0.01,
        window_ms: 900,
        run_details: [],
      },
    })

    expect(result.pass).toBe(false)
    expect(result.failures).toContain("interaction_ms_worst")
  })

  test("keeps Web Vitals good lines warn-only in PR0.2", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "homepage-cold",
      base: {
        branch: "base",
        profile: "default",
        scenario: "homepage-cold",
        runs: 3,
        interaction_ms_median: 70,
        interaction_ms_worst: 95,
        interaction_ms: 70,
        interaction_delay_ms: 9,
        long_task_count: 0,
        long_task_max_ms: 0,
        tbt_ms: 0,
        frame_gap_p95_ms: 18,
        frame_gap_max_ms: 24,
        jank_count_50ms: 0,
        cls: 0.11,
        window_ms: 600,
        fcp_ms: 1500,
        lcp_ms: 2300,
        run_details: [],
      },
      head: {
        branch: "head",
        profile: "default",
        scenario: "homepage-cold",
        runs: 3,
        interaction_ms_median: 74,
        interaction_ms_worst: 99,
        interaction_ms: 74,
        interaction_delay_ms: 11,
        long_task_count: 0,
        long_task_max_ms: 0,
        tbt_ms: 0,
        frame_gap_p95_ms: 19,
        frame_gap_max_ms: 26,
        jank_count_50ms: 0,
        cls: 0.12,
        window_ms: 620,
        fcp_ms: 2400,
        lcp_ms: 3100,
        run_details: [],
      },
    })

    expect(result.pass).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.warnings).toEqual(expect.arrayContaining(["cls", "fcp_ms", "lcp_ms"]))
  })

  test("compares baseline collections by scenario and fails when a head scenario is missing", () => {
    const base = [
      aggregatePerfRuns({
        branch: "base",
        scenario: "homepage-cold",
        runs: [
          {
            interaction_ms: 60,
            interaction_delay_ms: 8,
            long_task_count: 0,
            long_task_max_ms: 0,
            tbt_ms: 0,
            frame_gap_p95_ms: 18,
            frame_gap_max_ms: 26,
            jank_count_50ms: 0,
            cls: 0.01,
            window_ms: 800,
          },
        ],
      }),
      aggregatePerfRuns({
        branch: "base",
        scenario: "tool-call-expand",
        runs: [
          {
            interaction_ms: 70,
            interaction_delay_ms: 9,
            long_task_count: 1,
            long_task_max_ms: 75,
            tbt_ms: 25,
            frame_gap_p95_ms: 28,
            frame_gap_max_ms: 40,
            jank_count_50ms: 0,
            cls: 0.002,
            window_ms: 900,
          },
        ],
      }),
    ]
    const head = [base[0]]

    const result = comparePerfBaselines({ base, head })

    expect(result.pass).toBe(false)
    expect(result.failures).toContain("missing_head_scenario:default:tool-call-expand")
  })

  test("compares baseline collections by profile and scenario", () => {
    const base = [
      scenario({ branch: "base", profile: "default", scenario: "session-timeline-recompute" }),
      scenario({ branch: "base", profile: "low-end", scenario: "session-timeline-recompute" }),
    ]
    const head = [
      scenario({ branch: "head", profile: "default", scenario: "session-timeline-recompute" }),
      scenario({ branch: "head", profile: "low-end", scenario: "session-timeline-recompute", interaction: 60 }),
    ]

    const result = comparePerfBaselines({ base, head })

    expect(result.scenarios.map((entry) => `${entry.profile}:${entry.scenario}`)).toEqual([
      "default:session-timeline-recompute",
      "low-end:session-timeline-recompute",
    ])
  })

  test("fails when the matching profile and scenario is missing", () => {
    const base = [
      scenario({ branch: "base", profile: "default", scenario: "session-timeline-recompute" }),
      scenario({ branch: "base", profile: "low-end", scenario: "session-timeline-recompute" }),
    ]
    const head = [scenario({ branch: "head", profile: "default", scenario: "session-timeline-recompute" })]

    const result = comparePerfBaselines({ base, head })

    expect(result.pass).toBe(false)
    expect(result.failures).toContain("missing_head_scenario:low-end:session-timeline-recompute")
  })

  test("restricts confirmation comparisons to the originally failing scenarios", () => {
    const base = [scenario({ branch: "base", scenario: "session-scroll-reading", interaction: 32 })]
    const head = [
      scenario({ branch: "head", scenario: "session-scroll-reading", interaction: 40 }),
      scenario({ branch: "head", scenario: "homepage-cold", frameMax: 183 }),
    ]

    const result = comparePerfBaselines({ base, head, scenarioKeys: ["default:session-scroll-reading"] })

    expect(result.pass).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.scenarios.map((entry) => `${entry.profile}:${entry.scenario}`)).toEqual([
      "default:session-scroll-reading",
    ])
  })

  test("does not confirm a different metric failure from the same scenario", () => {
    const result = comparePerfBaselines({
      base: [scenario({ branch: "base", scenario: "session-scroll-reading", interaction: 32, frameMax: 16 })],
      head: [scenario({ branch: "head", scenario: "session-scroll-reading", interaction: 40, frameMax: 120 })],
      scenarioKeys: ["default:session-scroll-reading"],
      failureKeys: ["default:session-scroll-reading:interaction_ms_median"],
    })

    expect(result.pass).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.scenarios[0].failures).toHaveLength(0)
    expect(result.confirmation).toEqual({
      initialFailureKeys: ["default:session-scroll-reading:interaction_ms_median"],
      rawConfirmedFailures: ["default:session-scroll-reading:frame_gap_max_ms_delta"],
      intersectedFailures: [],
    })
  })

  test("confirms the same metric failure from the same scenario", () => {
    const result = comparePerfBaselines({
      base: [scenario({ branch: "base", scenario: "session-scroll-reading", interaction: 48 })],
      head: [scenario({ branch: "head", scenario: "session-scroll-reading", interaction: 76 })],
      scenarioKeys: ["default:session-scroll-reading"],
      failureKeys: ["default:session-scroll-reading:interaction_ms_median"],
    })

    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(["default:session-scroll-reading:interaction_ms_median"])
    expect(result.scenarios[0].failures).toEqual(["interaction_ms_median"])
    expect(result.confirmation).toEqual({
      initialFailureKeys: ["default:session-scroll-reading:interaction_ms_median"],
      rawConfirmedFailures: ["default:session-scroll-reading:interaction_ms_median"],
      intersectedFailures: ["default:session-scroll-reading:interaction_ms_median"],
    })
  })

  test("keeps missing requested confirmation scenarios as hard failures", () => {
    const missingHead = comparePerfBaselines({
      base: [scenario({ branch: "base", scenario: "session-scroll-reading" })],
      head: [],
      scenarioKeys: ["default:session-scroll-reading"],
      failureKeys: ["default:session-scroll-reading:interaction_ms_median"],
    })
    const missingBase = comparePerfBaselines({
      base: [],
      head: [scenario({ branch: "head", scenario: "session-scroll-reading" })],
      scenarioKeys: ["default:session-scroll-reading"],
      failureKeys: ["default:session-scroll-reading:interaction_ms_median"],
    })
    const missingBoth = comparePerfBaselines({
      base: [],
      head: [],
      scenarioKeys: ["default:session-scroll-reading"],
      failureKeys: ["default:session-scroll-reading:interaction_ms_median"],
    })

    expect(missingHead.pass).toBe(false)
    expect(missingHead.failures).toEqual(["missing_head_scenario:default:session-scroll-reading"])
    expect(missingBase.pass).toBe(false)
    expect(missingBase.failures).toEqual(["missing_base_scenario:default:session-scroll-reading"])
    expect(missingBoth.pass).toBe(false)
    expect(missingBoth.failures).toEqual([
      "missing_base_scenario:default:session-scroll-reading",
      "missing_head_scenario:default:session-scroll-reading",
    ])
  })

  test("keeps low-end moderate regressions warning-only", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "session-timeline-recompute",
      base: scenario({ branch: "base", profile: "low-end", interaction: 100, worst: 150 }),
      head: scenario({ branch: "head", profile: "low-end", interaction: 126, worst: 190 }),
    })

    expect(result.pass).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.warnings).toContain("interaction_ms_median")
  })

  test("fails low-end catastrophic regressions", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "session-timeline-recompute",
      base: scenario({ branch: "base", profile: "low-end", interaction: 120, worst: 240, longTask: 120 }),
      head: scenario({ branch: "head", profile: "low-end", interaction: 180, worst: 760, longTask: 360 }),
    })

    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(expect.arrayContaining(["interaction_ms_worst", "long_task_max_ms"]))
  })

  test("does not fail low-end absolute slowness without regression", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "session-timeline-recompute",
      base: scenario({ branch: "base", profile: "low-end", interaction: 120, worst: 760, longTask: 340 }),
      head: scenario({ branch: "head", profile: "low-end", interaction: 121, worst: 761, longTask: 341 }),
    })

    expect(result.pass).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  test("renders a markdown comment with scenario deltas and fail or warn status", () => {
    const comparison = comparePerfBaselines({
      base: [
        aggregatePerfRuns({
          branch: "base",
          scenario: "homepage-cold",
          runs: [
            {
              interaction_ms: 40,
              interaction_delay_ms: 2,
              long_task_count: 0,
              long_task_max_ms: 0,
              tbt_ms: 0,
              frame_gap_p95_ms: 16,
              frame_gap_max_ms: 24,
              jank_count_50ms: 0,
              cls: 0,
              window_ms: 900,
            },
          ],
        }),
        aggregatePerfRuns({
          branch: "base",
          scenario: "session-scroll-reading",
          runs: [
            {
              interaction_ms: 16,
              interaction_delay_ms: 1,
              long_task_count: 0,
              long_task_max_ms: 0,
              tbt_ms: 0,
              frame_gap_p95_ms: 16,
              frame_gap_max_ms: 16,
              jank_count_50ms: 0,
              cls: 0.01,
              window_ms: 300,
            },
          ],
        }),
      ],
      head: [
        aggregatePerfRuns({
          branch: "head",
          scenario: "homepage-cold",
          runs: [
            {
              interaction_ms: 40,
              interaction_delay_ms: 2,
              long_task_count: 0,
              long_task_max_ms: 0,
              tbt_ms: 0,
              frame_gap_p95_ms: 16,
              frame_gap_max_ms: 24,
              jank_count_50ms: 0,
              cls: 0,
              window_ms: 900,
              fcp_ms: 2400,
              lcp_ms: 3100,
            },
          ],
        }),
        aggregatePerfRuns({
          branch: "head",
          scenario: "session-scroll-reading",
          runs: [
            {
              interaction_ms: 40,
              interaction_delay_ms: 1,
              long_task_count: 0,
              long_task_max_ms: 0,
              tbt_ms: 0,
              frame_gap_p95_ms: 16,
              frame_gap_max_ms: 16,
              jank_count_50ms: 0,
              cls: 0.01,
              window_ms: 300,
            },
          ],
        }),
      ],
    })

    const comment = renderPerfBaselineComment(comparison)

    expect(comment).toContain(PERF_COMMENT_MARKER)
    expect(comment).toContain("## Perf delta summary")
    expect(comment).toContain("| default / homepage-cold |")
    expect(comment).toContain("| default / session-scroll-reading |")
    expect(comment).toContain("warn: fcp_ms, lcp_ms")
    expect(comment).toContain("fail: interaction_ms_median")
  })
})
