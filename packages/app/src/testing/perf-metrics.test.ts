import { describe, expect, test } from "bun:test"
import { aggregatePerfRuns, comparePerfBaselines, comparePerfScenarioSummaries, summarizePerfRun } from "./perf-metrics"

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

  test("fails a scenario when median regression breaks both the ms and percentage budgets", () => {
    const result = comparePerfScenarioSummaries({
      scenario: "session-streaming-long",
      base: {
        branch: "base",
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
        scenario: "session-streaming-long",
        runs: 3,
        interaction_ms_median: 116,
        interaction_ms_worst: 168,
        interaction_ms: 116,
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
    expect(result.failures).toContain("missing_head_scenario:tool-call-expand")
  })
})
