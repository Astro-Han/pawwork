import { describe, expect, test } from "bun:test"
import { aggregatePerfRuns, summarizePerfRun } from "./perf-metrics"

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
})
