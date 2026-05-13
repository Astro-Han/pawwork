export type PerfInteractionSample = {
  at: number
  delay: number
  duration: number
}

export type PerfDurationSample = {
  at: number
  duration: number
}

export type PerfShiftSample = {
  at: number
  value: number
}

export type PerfRunSample = {
  startedAt: number
  endedAt: number
  interactions: PerfInteractionSample[]
  longTasks: PerfDurationSample[]
  frames: PerfDurationSample[]
  shifts: PerfShiftSample[]
  fcpMs?: number
  lcpMs?: number
  heapUsedMb?: number
}

export type PerfRunSummary = {
  interaction_ms: number
  interaction_delay_ms: number
  long_task_count: number
  long_task_max_ms: number
  tbt_ms: number
  frame_gap_p95_ms: number
  frame_gap_max_ms: number
  jank_count_50ms: number
  cls: number
  window_ms: number
  fcp_ms?: number
  lcp_ms?: number
  heap_used_mb?: number
}

export type PerfScenarioSummary = PerfRunSummary & {
  branch: string
  scenario: string
  runs: number
  interaction_ms_median: number
  interaction_ms_worst: number
  run_details: PerfRunSummary[]
}

function round(input: number) {
  return Math.round(input * 1000) / 1000
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1)
  return sorted[index]
}

function pickWindow<T extends { at: number }>(items: T[], start: number, end: number) {
  return items.filter((item) => item.at >= start && item.at <= end)
}

function optionalMedian(values: Array<number | undefined>) {
  const filtered = values.filter((value): value is number => typeof value === "number")
  if (filtered.length === 0) return undefined
  return round(median(filtered))
}

export function summarizePerfRun(input: PerfRunSample): PerfRunSummary {
  const startedAt = input.startedAt
  const endedAt = Math.max(input.endedAt, startedAt)
  const interactions = pickWindow(input.interactions, startedAt, endedAt)
  const longTasks = pickWindow(input.longTasks, startedAt, endedAt)
  const frames = pickWindow(input.frames, startedAt, endedAt)
  const shifts = pickWindow(input.shifts, startedAt, endedAt)

  const interaction = interactions.reduce((max, entry) => Math.max(max, entry.duration), 0)
  const interactionDelay = interactions.reduce((max, entry) => Math.max(max, entry.delay), 0)
  const longTaskMax = longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0)
  const tbt = longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0)
  const frameDurations = frames.map((entry) => entry.duration)
  const frameGapP95 = percentile(frameDurations, 0.95)
  const frameGapMax = frameDurations.reduce((max, value) => Math.max(max, value), 0)
  const jankCount = frameDurations.filter((value) => value > 50).length
  const cls = shifts.reduce((sum, entry) => sum + entry.value, 0)

  return {
    interaction_ms: round(interaction),
    interaction_delay_ms: round(interactionDelay),
    long_task_count: longTasks.length,
    long_task_max_ms: round(longTaskMax),
    tbt_ms: round(tbt),
    frame_gap_p95_ms: round(frameGapP95),
    frame_gap_max_ms: round(frameGapMax),
    jank_count_50ms: jankCount,
    cls: round(cls),
    window_ms: round(endedAt - startedAt),
    fcp_ms: input.fcpMs === undefined ? undefined : round(input.fcpMs),
    lcp_ms: input.lcpMs === undefined ? undefined : round(input.lcpMs),
    heap_used_mb: input.heapUsedMb === undefined ? undefined : round(input.heapUsedMb),
  }
}

export function aggregatePerfRuns(input: {
  branch: string
  scenario: string
  runs: PerfRunSummary[]
}): PerfScenarioSummary {
  const runs = input.runs
  if (runs.length === 0) {
    throw new Error(`Cannot aggregate perf runs for ${input.scenario} without samples`)
  }

  return {
    branch: input.branch,
    scenario: input.scenario,
    runs: runs.length,
    interaction_ms_median: round(median(runs.map((run) => run.interaction_ms))),
    interaction_ms_worst: round(runs.reduce((max, run) => Math.max(max, run.interaction_ms), 0)),
    interaction_ms: round(median(runs.map((run) => run.interaction_ms))),
    interaction_delay_ms: round(median(runs.map((run) => run.interaction_delay_ms))),
    long_task_count: round(median(runs.map((run) => run.long_task_count))),
    long_task_max_ms: round(median(runs.map((run) => run.long_task_max_ms))),
    tbt_ms: round(median(runs.map((run) => run.tbt_ms))),
    frame_gap_p95_ms: round(median(runs.map((run) => run.frame_gap_p95_ms))),
    frame_gap_max_ms: round(median(runs.map((run) => run.frame_gap_max_ms))),
    jank_count_50ms: round(median(runs.map((run) => run.jank_count_50ms))),
    cls: round(median(runs.map((run) => run.cls))),
    window_ms: round(median(runs.map((run) => run.window_ms))),
    fcp_ms: optionalMedian(runs.map((run) => run.fcp_ms)),
    lcp_ms: optionalMedian(runs.map((run) => run.lcp_ms)),
    heap_used_mb: optionalMedian(runs.map((run) => run.heap_used_mb)),
    run_details: runs,
  }
}
