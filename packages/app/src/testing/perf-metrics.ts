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

export type PerfProfile = "default" | "low-end"

export type PerfScenarioSummary = PerfRunSummary & {
  branch: string
  profile: PerfProfile
  scenario: string
  runs: number
  interaction_ms_median: number
  interaction_ms_worst: number
  run_details: PerfRunSummary[]
}

export type PerfScenarioComparison = {
  profile: PerfProfile
  scenario: string
  pass: boolean
  failures: string[]
  warnings: string[]
  base: PerfScenarioSummary
  head: PerfScenarioSummary
}

export type PerfFailureKey = string

export type PerfBaselineConfirmation = {
  initialFailureKeys: PerfFailureKey[]
  rawConfirmedFailures: string[]
  intersectedFailures: string[]
}

export type PerfBaselineComparison = {
  pass: boolean
  failures: string[]
  warnings: string[]
  scenarios: PerfScenarioComparison[]
  confirmation?: PerfBaselineConfirmation
}

export const PERF_COMMENT_MARKER = "<!-- pawwork-perf-probe-baseline -->"

const perfDeltaThresholds = {
  interactionMedianMs: 20,
  interactionMedianRatio: 1.05,
  interactionWorstMs: 50,
  longTaskMaxMs: 25,
  tbtMs: 50,
  // One frame at 60Hz is 16.67ms, so a tolerance below that flags single-frame
  // CI runner jitter as a regression. Aligned with lowEndWarningThresholds.frameGapP95Ms
  // so the default profile is no stricter than low-end.
  frameGapP95Ms: 20,
  frameGapMaxMs: 50,
  jankCount: 2,
  cls: 0.02,
} as const

const perfAbsoluteWarnings = {
  interactionMsWorst: 200,
  tbtMs: 200,
  cls: 0.05,
  fcpMs: 1800,
  lcpMs: 2500,
} as const

const perfCatastrophicThresholds = {
  interactionMsWorst: 500,
  frameGapMaxMs: 500,
  longTaskMaxMs: 250,
} as const

const lowEndWarningThresholds = {
  interactionMedianMs: 20,
  interactionMedianRatio: 1.15,
  interactionWorstMs: 80,
  longTaskMaxMs: 60,
  tbtMs: 120,
  frameGapP95Ms: 20,
  frameGapMaxMs: 120,
  jankCount: 4,
  cls: 0.04,
} as const

const lowEndCatastrophicThresholds = {
  interactionMsWorst: 700,
  frameGapMaxMs: 700,
  longTaskMaxMs: 300,
} as const

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
  profile?: PerfProfile
  scenario: string
  runs: PerfRunSummary[]
}): PerfScenarioSummary {
  const runs = input.runs
  if (runs.length === 0) {
    throw new Error(`Cannot aggregate perf runs for ${input.scenario} without samples`)
  }

  return {
    branch: input.branch,
    profile: input.profile ?? "default",
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

function exceededByDelta(input: { base: number; head: number; maxDelta: number; maxRatio?: number }) {
  const delta = input.head - input.base
  if (delta <= input.maxDelta) return false
  if (input.maxRatio === undefined) return true
  if (input.base <= 0) return true
  return input.head > input.base * input.maxRatio
}

function addAbsoluteWarning(target: string[], key: string, value: number | undefined, threshold: number) {
  if (value === undefined) return
  if (value > threshold) target.push(key)
}

function formatDelta(value: number) {
  if (value === 0) return "0"
  return `${value > 0 ? "+" : ""}${round(value)}`
}

function formatMetricDelta(base: number, head: number) {
  return `${base} -> ${head} (${formatDelta(head - base)})`
}

function scenarioStatus(input: PerfScenarioComparison) {
  if (input.failures.length > 0) return `fail: ${input.failures.join(", ")}`
  if (input.warnings.length > 0) return `warn: ${input.warnings.join(", ")}`
  return "pass"
}

export function renderPerfBaselineComment(input: PerfBaselineComparison) {
  const lines = [
    PERF_COMMENT_MARKER,
    "## Perf delta summary",
    "",
    `Comparator: ${input.pass ? "pass" : "fail"}`,
    "",
    "| Profile / Scenario | interaction median | interaction worst | long task max | tbt | frame gap p95 | frame gap max | jank count | cls | status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ]

  for (const scenario of input.scenarios) {
    const columns = [
      `${scenario.profile} / ${scenario.scenario}`,
      formatMetricDelta(scenario.base.interaction_ms_median, scenario.head.interaction_ms_median),
      formatMetricDelta(scenario.base.interaction_ms_worst, scenario.head.interaction_ms_worst),
      formatMetricDelta(scenario.base.long_task_max_ms, scenario.head.long_task_max_ms),
      formatMetricDelta(scenario.base.tbt_ms, scenario.head.tbt_ms),
      formatMetricDelta(scenario.base.frame_gap_p95_ms, scenario.head.frame_gap_p95_ms),
      formatMetricDelta(scenario.base.frame_gap_max_ms, scenario.head.frame_gap_max_ms),
      formatMetricDelta(scenario.base.jank_count_50ms, scenario.head.jank_count_50ms),
      formatMetricDelta(scenario.base.cls, scenario.head.cls),
      scenarioStatus(scenario),
    ]
    lines.push(`| ${columns.join(" | ")} |`)
  }

  if (input.failures.some((failure) => failure.startsWith("missing_"))) {
    lines.push("")
    lines.push(`Missing scenarios: ${input.failures.filter((failure) => failure.startsWith("missing_")).join(", ")}`)
  }

  return `${lines.join("\n")}\n`
}

export function comparePerfScenarioSummaries(input: {
  scenario: string
  base: PerfScenarioSummary
  head: PerfScenarioSummary
}): PerfScenarioComparison {
  const failures: string[] = []
  const warnings: string[] = []
  const profile = input.head.profile ?? input.base.profile ?? "default"

  if (profile === "low-end") {
    if (
      exceededByDelta({
        base: input.base.interaction_ms_median,
        head: input.head.interaction_ms_median,
        maxDelta: lowEndWarningThresholds.interactionMedianMs,
        maxRatio: lowEndWarningThresholds.interactionMedianRatio,
      })
    ) {
      warnings.push("interaction_ms_median")
    }
    const interactionWorstRegressed =
      input.head.interaction_ms_worst > input.base.interaction_ms_worst + lowEndWarningThresholds.interactionWorstMs
    if (interactionWorstRegressed) {
      warnings.push("interaction_ms_worst_delta")
    }
    if (
      interactionWorstRegressed &&
      input.head.interaction_ms_worst >= lowEndCatastrophicThresholds.interactionMsWorst
    ) {
      failures.push("interaction_ms_worst")
    }
    const longTaskRegressed =
      input.head.long_task_max_ms > input.base.long_task_max_ms + lowEndWarningThresholds.longTaskMaxMs
    if (longTaskRegressed) {
      warnings.push("long_task_max_ms_delta")
    }
    if (longTaskRegressed && input.head.long_task_max_ms >= lowEndCatastrophicThresholds.longTaskMaxMs) {
      failures.push("long_task_max_ms")
    }
    if (input.head.tbt_ms > input.base.tbt_ms + lowEndWarningThresholds.tbtMs) {
      warnings.push("tbt_ms")
    }
    if (input.head.frame_gap_p95_ms > input.base.frame_gap_p95_ms + lowEndWarningThresholds.frameGapP95Ms) {
      warnings.push("frame_gap_p95_ms")
    }
    const frameGapMaxRegressed =
      input.head.frame_gap_max_ms > input.base.frame_gap_max_ms + lowEndWarningThresholds.frameGapMaxMs
    if (frameGapMaxRegressed) {
      warnings.push("frame_gap_max_ms_delta")
    }
    if (frameGapMaxRegressed && input.head.frame_gap_max_ms >= lowEndCatastrophicThresholds.frameGapMaxMs) {
      failures.push("frame_gap_max_ms")
    }
    if (input.head.jank_count_50ms > input.base.jank_count_50ms + lowEndWarningThresholds.jankCount) {
      warnings.push("jank_count_50ms")
    }
    if (input.head.cls > input.base.cls + lowEndWarningThresholds.cls) {
      warnings.push("cls_delta")
    }

    return {
      profile,
      scenario: input.scenario,
      pass: failures.length === 0,
      failures: [...new Set(failures)],
      warnings: [...new Set(warnings)],
      base: input.base,
      head: input.head,
    }
  }

  if (
    exceededByDelta({
      base: input.base.interaction_ms_median,
      head: input.head.interaction_ms_median,
      maxDelta: perfDeltaThresholds.interactionMedianMs,
      maxRatio: perfDeltaThresholds.interactionMedianRatio,
    })
  ) {
    failures.push("interaction_ms_median")
  }

  if (input.head.interaction_ms_worst > input.base.interaction_ms_worst + perfDeltaThresholds.interactionWorstMs) {
    failures.push("interaction_ms_worst_delta")
  }
  if (input.head.interaction_ms_worst >= perfCatastrophicThresholds.interactionMsWorst) {
    failures.push("interaction_ms_worst")
  }
  if (input.head.long_task_max_ms > input.base.long_task_max_ms + perfDeltaThresholds.longTaskMaxMs) {
    failures.push("long_task_max_ms_delta")
  }
  if (input.head.long_task_max_ms >= perfCatastrophicThresholds.longTaskMaxMs) {
    failures.push("long_task_max_ms")
  }
  if (input.head.tbt_ms > input.base.tbt_ms + perfDeltaThresholds.tbtMs) {
    failures.push("tbt_ms")
  }
  if (input.head.frame_gap_p95_ms > input.base.frame_gap_p95_ms + perfDeltaThresholds.frameGapP95Ms) {
    failures.push("frame_gap_p95_ms")
  }
  if (input.head.frame_gap_max_ms > input.base.frame_gap_max_ms + perfDeltaThresholds.frameGapMaxMs) {
    failures.push("frame_gap_max_ms_delta")
  }
  if (input.head.frame_gap_max_ms >= perfCatastrophicThresholds.frameGapMaxMs) {
    failures.push("frame_gap_max_ms")
  }
  if (input.head.jank_count_50ms > input.base.jank_count_50ms + perfDeltaThresholds.jankCount) {
    failures.push("jank_count_50ms")
  }
  if (input.head.cls > input.base.cls + perfDeltaThresholds.cls) {
    failures.push("cls_delta")
  }

  addAbsoluteWarning(
    warnings,
    "interaction_ms_worst",
    input.head.interaction_ms_worst,
    perfAbsoluteWarnings.interactionMsWorst,
  )
  addAbsoluteWarning(warnings, "tbt_ms", input.head.tbt_ms, perfAbsoluteWarnings.tbtMs)
  addAbsoluteWarning(warnings, "cls", input.head.cls, perfAbsoluteWarnings.cls)
  addAbsoluteWarning(warnings, "fcp_ms", input.head.fcp_ms, perfAbsoluteWarnings.fcpMs)
  addAbsoluteWarning(warnings, "lcp_ms", input.head.lcp_ms, perfAbsoluteWarnings.lcpMs)

  return {
    profile,
    scenario: input.scenario,
    pass: failures.length === 0,
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)],
    base: input.base,
    head: input.head,
  }
}

function scenarioKey(input: { profile?: PerfProfile; scenario: string }) {
  return `${input.profile ?? "default"}:${input.scenario}`
}

export function perfFailureKey(input: { profile?: PerfProfile; scenario: string; metric: string }): PerfFailureKey {
  return `${scenarioKey(input)}:${input.metric}`
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value)
}

export function comparePerfBaselines(input: {
  base: PerfScenarioSummary[]
  head: PerfScenarioSummary[]
  scenarioKeys?: string[]
  failureKeys?: PerfFailureKey[]
}): PerfBaselineComparison {
  const failures: string[] = []
  const warnings: string[] = []
  const scenarios: PerfScenarioComparison[] = []
  const baseByScenario = new Map(input.base.map((scenario) => [scenarioKey(scenario), scenario]))
  const headByScenario = new Map(input.head.map((scenario) => [scenarioKey(scenario), scenario]))
  const requestedScenarioKeys = input.scenarioKeys ? [...new Set(input.scenarioKeys)] : undefined
  const requestedFailureKeys = input.failureKeys ? new Set(input.failureKeys) : undefined
  const confirmation: PerfBaselineConfirmation | undefined = input.failureKeys
    ? {
        initialFailureKeys: [...new Set(input.failureKeys)],
        rawConfirmedFailures: [],
        intersectedFailures: [],
      }
    : undefined

  function addHardFailure(failure: string) {
    pushUnique(failures, failure)
    if (!confirmation) return
    pushUnique(confirmation.rawConfirmedFailures, failure)
    pushUnique(confirmation.intersectedFailures, failure)
  }

  const comparisonKeys = requestedScenarioKeys ?? input.base.map((scenario) => scenarioKey(scenario))

  for (const key of comparisonKeys) {
    const baseScenario = baseByScenario.get(key)
    const headScenario = headByScenario.get(key)
    if (!baseScenario) {
      addHardFailure(`missing_base_scenario:${key}`)
    }
    if (!headScenario) {
      addHardFailure(`missing_head_scenario:${key}`)
    }
    if (!baseScenario || !headScenario) {
      continue
    }

    const rawComparison = comparePerfScenarioSummaries({
      scenario: baseScenario.scenario,
      base: baseScenario,
      head: headScenario,
    })
    const filteredFailures: string[] = []
    for (const failure of rawComparison.failures) {
      const fullFailureKey = perfFailureKey({
        profile: rawComparison.profile,
        scenario: rawComparison.scenario,
        metric: failure,
      })
      if (confirmation) pushUnique(confirmation.rawConfirmedFailures, fullFailureKey)
      if (requestedFailureKeys && !requestedFailureKeys.has(fullFailureKey)) continue
      pushUnique(filteredFailures, failure)
      pushUnique(failures, fullFailureKey)
      if (confirmation) pushUnique(confirmation.intersectedFailures, fullFailureKey)
    }

    const comparison = requestedFailureKeys
      ? {
          ...rawComparison,
          pass: filteredFailures.length === 0,
          failures: filteredFailures,
        }
      : rawComparison
    scenarios.push(comparison)
    for (const warning of comparison.warnings) pushUnique(warnings, `${key}:${warning}`)
  }

  if (!requestedScenarioKeys) {
    for (const headScenario of input.head) {
      const key = scenarioKey(headScenario)
      if (!baseByScenario.has(key)) {
        addHardFailure(`missing_base_scenario:${key}`)
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    warnings,
    scenarios,
    confirmation,
  }
}
