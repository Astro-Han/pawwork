import type { ScheduleDraft } from "./automation-schedule-form"

// The three starter templates that prefill the manual create card (kills the
// blank page). Title/prompt are i18n keys; schedule is a concrete draft. There
// is no separate template gallery — this list plus the card's "Use template"
// are the only entry points.

export interface AutomationTemplate {
  id: string
  icon: string
  titleKey: string
  promptKey: string
  schedule: ScheduleDraft
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "daily-brief",
    icon: "bullet-list",
    titleKey: "automations.template.dailyBrief.title",
    promptKey: "automations.template.dailyBrief.prompt",
    schedule: { frequency: "daily", hour: 9, minute: 0, weekday: 1, cron: "0 9 * * *" },
  },
  {
    id: "weekly-review",
    icon: "review",
    titleKey: "automations.template.weeklyReview.title",
    promptKey: "automations.template.weeklyReview.prompt",
    schedule: { frequency: "weekly", hour: 9, minute: 0, weekday: 1, cron: "0 9 * * 1" },
  },
  {
    id: "project-monitor",
    icon: "magnifying-glass",
    titleKey: "automations.template.projectMonitor.title",
    promptKey: "automations.template.projectMonitor.prompt",
    schedule: { frequency: "weekdays", hour: 9, minute: 0, weekday: 1, cron: "0 9 * * 1-5" },
  },
]
