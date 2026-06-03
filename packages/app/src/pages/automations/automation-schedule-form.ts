import { DateTime } from "luxon"

// Input side of the schedule picker (draft -> AutomationCreateInput). The
// read side (definition -> human label) lives in automation-schedule.ts; the
// cron shapes emitted here are exactly the ones formatCron there humanizes.

type Translate = (key: string, vars?: Record<string, string | number>) => string

export type ScheduleFrequency = "once" | "hourly" | "daily" | "weekdays" | "weekly" | "custom"

// The create card only exposes one-shot + cron rhythms; interval-after-completion
// stays a power-user/SDK feature and is intentionally off this surface.
export const SCHEDULE_FREQUENCIES: ScheduleFrequency[] = ["once", "hourly", "daily", "weekdays", "weekly", "custom"]

export interface ScheduleDraft {
  frequency: ScheduleFrequency
  hour: number // 0-23
  minute: number // 0-59
  weekday: number // cron day-of-week 0=Sun..6=Sat
  cron: string // raw expression, only used by "custom"
}

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  frequency: "daily",
  hour: 9,
  minute: 0,
  weekday: 1,
  cron: "0 9 * * *",
}

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

export function scheduleTimeLabel(draft: ScheduleDraft): string {
  return `${pad(draft.hour)}:${pad(draft.minute)}`
}

// Frequencies that show the time-of-day control. "once" reuses it to pick the
// next occurrence; "hourly" runs every hour at minute 0; "custom" owns the cron.
export function scheduleUsesTime(frequency: ScheduleFrequency): boolean {
  return frequency === "once" || frequency === "daily" || frequency === "weekdays" || frequency === "weekly"
}

export function cronForSchedule(draft: ScheduleDraft): string {
  switch (draft.frequency) {
    case "hourly":
      return "0 * * * *"
    case "weekdays":
      return `${draft.minute} ${draft.hour} * * 1-5`
    case "weekly":
      return `${draft.minute} ${draft.hour} * * ${draft.weekday}`
    case "custom":
      return draft.cron.trim()
    // "once" never emits a cron (it becomes a one-shot fireAt) but keep the
    // daily shape so a caller that asks anyway gets a sane expression.
    case "once":
    case "daily":
      return `${draft.minute} ${draft.hour} * * *`
  }
}

// Next occurrence of HH:MM in the definition's timezone, strictly after `now`.
function nextDailyFireAt(hour: number, minute: number, timezone: string, now: number): number {
  const base = DateTime.fromMillis(now, { zone: timezone })
  let next = base.set({ hour, minute, second: 0, millisecond: 0 })
  if (next.toMillis() <= now) next = next.plus({ days: 1 })
  return next.toMillis()
}

// The schedule-shaped slice of AutomationCreateInput: a one-shot fireAt or a
// recurring cron rhythm. Caller merges title/prompt/model/where/context/stop.
export function buildScheduleInput(
  draft: ScheduleDraft,
  timezone: string,
  now: number,
):
  | { kind: "oneshot"; fireAt: number }
  | { kind: "recurring"; rhythm: { kind: "cron"; expression: string } } {
  if (draft.frequency === "once") {
    return { kind: "oneshot", fireAt: nextDailyFireAt(draft.hour, draft.minute, timezone, now) }
  }
  return { kind: "recurring", rhythm: { kind: "cron", expression: cronForSchedule(draft) } }
}

// Short label for the Schedule knob / popover trigger, reusing the same i18n
// keys the definition formatter uses so the card and the list stay consistent.
export function formatScheduleDraft(draft: ScheduleDraft, t: Translate): string {
  const time = scheduleTimeLabel(draft)
  switch (draft.frequency) {
    case "once":
      return t("automations.schedule.once")
    case "hourly":
      return t("automations.schedule.hourly")
    case "daily":
      return t("automations.schedule.daily", { time })
    case "weekdays":
      return t("automations.schedule.weekdays", { time })
    case "weekly":
      return t("automations.schedule.weekly", { day: t(`automations.schedule.weekday.${draft.weekday}`), time })
    case "custom":
      return t("automations.schedule.custom")
  }
}

export function frequencyLabel(frequency: ScheduleFrequency, t: Translate): string {
  return t(`automations.create.frequency.${frequency}`)
}
