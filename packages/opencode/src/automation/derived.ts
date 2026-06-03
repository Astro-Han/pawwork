import { DateTime } from "luxon"
import type { Automation } from "."
import { type CronSchedule, parseCronSchedule } from "./cron"

const CRON_LOOKAHEAD_MINUTES = 527_040 * 5
const NEXT_FIRES_PREVIEW = 5

type RecurringDefinition = Extract<Automation.Definition, { kind: "recurring" }>

const PLUS_ONE_MONTH = { months: 1 }
const PLUS_ONE_DAY = { days: 1 }
const PLUS_ONE_HOUR = { hours: 1 }
const PLUS_ONE_MINUTE = { minutes: 1 }

function collectCronFires(expression: string, timezone: string, from: number, count: number): number[] {
  if (count <= 0) return []
  let schedule: CronSchedule
  try {
    schedule = parseCronSchedule(expression)
  } catch {
    return []
  }
  const fires: number[] = []
  const maxTimestamp = from + CRON_LOOKAHEAD_MINUTES * 60 * 1000
  let cursor = DateTime.fromMillis(from, { zone: timezone }).plus(PLUS_ONE_MINUTE).startOf("minute")
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

function nextCronFires(definition: RecurringDefinition, from: number, count: number): number[] {
  if (definition.rhythm.kind !== "cron") return []
  return collectCronFires(definition.rhythm.expression, definition.timezone, from, count)
}

/** First cron fire strictly after `from` in `timezone`, or null if none within the lookahead window. */
export function nextCronFireAfter(expression: string, timezone: string, from: number): number | null {
  return collectCronFires(expression, timezone, from, 1)[0] ?? null
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
