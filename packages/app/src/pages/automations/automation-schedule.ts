import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"

type Translate = (key: string, vars?: Record<string, string | number>) => string

function pad(value: number) {
  return value.toString().padStart(2, "0")
}

function formatInterval(everyMs: number, t: Translate) {
  if (everyMs < 60000) {
    const seconds = Math.round(everyMs / 1000)
    return t("automations.schedule.every", { duration: t("automations.schedule.seconds", { count: seconds }) })
  }
  const minutes = Math.round(everyMs / 60000)
  // Only collapse to an hour label when the minutes divide evenly; otherwise the
  // exact minute count is shown so a 90-minute cadence isn't rounded to "2 h".
  if (minutes % 60 !== 0) return t("automations.schedule.every", { duration: t("automations.schedule.minutes", { count: minutes }) })
  const hours = minutes / 60
  return t("automations.schedule.every", { duration: t("automations.schedule.hours", { count: hours }) })
}

// Humanize the cron shapes the create card emits (hourly / daily / weekdays /
// weekly). Anything else is reported as a custom schedule rather than guessed.
function formatCron(expression: string, t: Translate) {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return t("automations.schedule.custom")
  const [minute, hour, dom, month, dow] = parts
  const everyDay = dom === "*" && month === "*"
  if (!everyDay) return t("automations.schedule.custom")

  // "Hourly" only fits a single fixed minute on every hour and day (e.g.
  // `0 * * * *`); a stepped/ranged minute like `*/15 * * * *` runs more often.
  if (hour === "*") {
    if (dow === "*" && /^[0-5]?\d$/.test(minute)) return t("automations.schedule.hourly")
    return t("automations.schedule.custom")
  }

  const minuteNum = Number(minute)
  const hourNum = Number(hour)
  if (!Number.isInteger(minuteNum) || !Number.isInteger(hourNum)) return t("automations.schedule.custom")
  const time = `${pad(hourNum)}:${pad(minuteNum)}`

  if (dow === "*") return t("automations.schedule.daily", { time })
  if (dow === "1-5") return t("automations.schedule.weekdays", { time })
  // A single weekday (cron 0=Sun..6=Sat) must name the day, otherwise Monday and
  // Friday at the same time render identically.
  if (/^[0-6]$/.test(dow)) {
    const day = t(`automations.schedule.weekday.${dow}`)
    return t("automations.schedule.weekly", { day, time })
  }
  return t("automations.schedule.custom")
}

export function formatScheduleSummary(definition: AutomationDefinition, t: Translate): string {
  if (definition.kind === "oneshot") return t("automations.schedule.once")
  if (definition.rhythm.kind === "interval") return formatInterval(definition.rhythm.everyMs, t)
  return formatCron(definition.rhythm.expression, t)
}

// Absolute short timestamp for future-facing fields (next run) where a "… ago"
// relative phrase would read wrong. Falls back to the host locale if the
// definition timezone is rejected by Intl.
export function formatTimestamp(ms: number, timezone?: string): string {
  if (!Number.isFinite(ms)) return ""
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: timezone }).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(ms))
  }
}
