import { DateTime } from "luxon"
import type { Automation } from "."

const CRON_LOOKAHEAD_MINUTES = 527_040 * 5
const NEXT_FIRES_PREVIEW = 5

type RecurringDefinition = Extract<Automation.Definition, { kind: "recurring" }>

type CronSchedule = {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  dayRestricted: boolean
  weekdayRestricted: boolean
}

function cronValues(field: string, min: number, max: number, options?: { sundayAlias?: boolean }) {
  const values = new Set<number>()
  for (const item of field.split(",")) {
    const [base, stepRaw] = item.split("/")
    if (!base || item.split("/").length > 2) throw new Error(`Invalid cron field: ${item}`)
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${item}`)
    const range = base === "*" ? [min, max] : base.split("-").map(Number)
    if (range.length === 0 || range.length > 2 || range.some((value) => !Number.isInteger(value))) {
      throw new Error(`Invalid cron field: ${item}`)
    }
    const start = range[0]
    const end = base === "*" || (range.length === 1 && stepRaw !== undefined) ? max : range.length === 1 ? range[0] : range[1]
    if (start < min || end > max || start > end) throw new Error(`Invalid cron range: ${item}`)
    for (let value = start; value <= end; value += step) {
      values.add(options?.sundayAlias && value === 7 ? 0 : value)
    }
  }
  return values
}

export function parseCronSchedule(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Invalid cron expression: ${expression}`)
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields
  return {
    minutes: cronValues(minuteField, 0, 59),
    hours: cronValues(hourField, 0, 23),
    days: cronValues(dayField, 1, 31),
    months: cronValues(monthField, 1, 12),
    weekdays: cronValues(weekdayField, 0, 7, { sundayAlias: true }),
    dayRestricted: dayField !== "*",
    weekdayRestricted: weekdayField !== "*",
  }
}

export function cronMatches(schedule: CronSchedule, time: DateTime) {
  const weekday = time.weekday === 7 ? 0 : time.weekday
  const dayMatches = schedule.days.has(time.day)
  const weekdayMatches = schedule.weekdays.has(weekday)
  const calendarMatches =
    schedule.dayRestricted && schedule.weekdayRestricted ? dayMatches || weekdayMatches : dayMatches && weekdayMatches
  return (
    schedule.minutes.has(time.minute) &&
    schedule.hours.has(time.hour) &&
    schedule.months.has(time.month) &&
    calendarMatches
  )
}

const PLUS_ONE_MONTH = { months: 1 }
const PLUS_ONE_DAY = { days: 1 }
const PLUS_ONE_HOUR = { hours: 1 }
const PLUS_ONE_MINUTE = { minutes: 1 }

function nextCronFires(definition: RecurringDefinition, from: number, count: number): number[] {
  if (definition.rhythm.kind !== "cron" || count <= 0) return []
  let schedule: CronSchedule
  try {
    schedule = parseCronSchedule(definition.rhythm.expression)
  } catch {
    return []
  }
  const fires: number[] = []
  const maxTimestamp = from + CRON_LOOKAHEAD_MINUTES * 60 * 1000
  let cursor = DateTime.fromMillis(from, { zone: definition.timezone }).plus(PLUS_ONE_MINUTE).startOf("minute")
  while (cursor.toMillis() < maxTimestamp && fires.length < count) {
    if (!schedule.months.has(cursor.month)) {
      cursor = cursor.plus(PLUS_ONE_MONTH).startOf("month")
      continue
    }
    const weekday = cursor.weekday === 7 ? 0 : cursor.weekday
    const dayMatches = schedule.days.has(cursor.day)
    const weekdayMatches = schedule.weekdays.has(weekday)
    const calendarMatches =
      schedule.dayRestricted && schedule.weekdayRestricted ? dayMatches || weekdayMatches : dayMatches && weekdayMatches
    if (!calendarMatches) {
      cursor = cursor.plus(PLUS_ONE_DAY).startOf("day")
      continue
    }
    if (!schedule.hours.has(cursor.hour)) {
      cursor = cursor.plus(PLUS_ONE_HOUR).startOf("hour")
      continue
    }
    if (schedule.minutes.has(cursor.minute)) fires.push(cursor.toMillis())
    cursor = cursor.plus(PLUS_ONE_MINUTE)
  }
  return fires
}

function nextIntervalFires(definition: RecurringDefinition, from: number, count: number): number[] {
  if (definition.rhythm.kind !== "interval" || count <= 0) return []
  const fires: number[] = []
  let cursor = from + definition.rhythm.everyMs
  for (let index = 0; index < count; index++) {
    fires.push(cursor)
    cursor += definition.rhythm.everyMs
  }
  return fires
}

export function computeDerivedFields(
  definition: RecurringDefinition,
  from: number,
  completedRunCount: number,
): { nextFireAt: number | null; nextFires: number[] } {
  if (definition.paused) return { nextFireAt: null, nextFires: [] }
  if (definition.stop.kind === "condition") return { nextFireAt: null, nextFires: [] }
  const remaining =
    definition.stop.kind === "count" ? Math.max(0, definition.stop.count - completedRunCount) : NEXT_FIRES_PREVIEW
  if (remaining <= 0) return { nextFireAt: null, nextFires: [] }
  const count = Math.min(NEXT_FIRES_PREVIEW, remaining)
  const fires =
    definition.rhythm.kind === "cron" ? nextCronFires(definition, from, count) : nextIntervalFires(definition, from, count)
  return { nextFireAt: fires[0] ?? null, nextFires: fires }
}
