import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"

type Translate = (key: string, vars?: Record<string, string | number>) => string

function pad(value: number) {
  return value.toString().padStart(2, "0")
}

function formatInterval(everyMs: number, t: Translate) {
  const minutes = Math.round(everyMs / 60000)
  if (minutes < 60) return t("automations.schedule.every", { duration: t("automations.schedule.minutes", { count: minutes }) })
  const hours = Math.round(minutes / 60)
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

  if (hour === "*") return t("automations.schedule.hourly")

  const minuteNum = Number(minute)
  const hourNum = Number(hour)
  if (!Number.isInteger(minuteNum) || !Number.isInteger(hourNum)) return t("automations.schedule.custom")
  const time = `${pad(hourNum)}:${pad(minuteNum)}`

  if (dow === "*") return t("automations.schedule.daily", { time })
  if (dow === "1-5") return t("automations.schedule.weekdays", { time })
  if (/^[0-6]$/.test(dow)) return t("automations.schedule.weekly", { time })
  return t("automations.schedule.custom")
}

export function formatScheduleSummary(definition: AutomationDefinition, t: Translate): string {
  if (definition.kind === "oneshot") return t("automations.schedule.once")
  if (definition.rhythm.kind === "interval") return formatInterval(definition.rhythm.everyMs, t)
  return formatCron(definition.rhythm.expression, t)
}
