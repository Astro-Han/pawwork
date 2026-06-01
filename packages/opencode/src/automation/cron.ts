import { DateTime } from "luxon"

export type CronSchedule = {
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
