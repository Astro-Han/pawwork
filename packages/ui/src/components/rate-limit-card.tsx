import { Show } from "solid-js"
import type { RetryClassification } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card, CardActions, CardDescription, CardTitle } from "./card"
import "./rate-limit-card.css"

export interface RateLimitCardProps {
  classification: Extract<RetryClassification, { kind: "free_quota_exhausted" }>
  onSubscribeClick: () => void
  onUseOwnModelClick: () => void
}

// Exported for unit testing. `dayOffset` is clamped to 0 | 1: anything past
// the next local-calendar day is treated as 1 (rare for daily-reset quotas).
export function formatResetTime(resetAt: number, now: number = Date.now()): { time: string; dayOffset: 0 | 1 } {
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(resetAt))
  const reset = new Date(resetAt)
  const today = new Date(now)
  const sameLocalDay =
    reset.getFullYear() === today.getFullYear() &&
    reset.getMonth() === today.getMonth() &&
    reset.getDate() === today.getDate()
  return { time, dayOffset: sameLocalDay ? 0 : 1 }
}

export function RateLimitCard(props: RateLimitCardProps) {
  const i18n = useI18n()
  return (
    <Card variant="warning" data-slot="rate-limit-card" data-kind="rate-limit-card">
      <CardTitle variant="warning">{i18n.t("ui.rateLimitCard.title")}</CardTitle>
      <CardDescription>
        <Show
          when={props.classification.resetAt !== undefined}
          fallback={i18n.t("ui.rateLimitCard.subtitleNoTime")}
        >
          {(() => {
            const { time, dayOffset } = formatResetTime(props.classification.resetAt!)
            const key =
              dayOffset === 0 ? "ui.rateLimitCard.subtitleResetToday" : "ui.rateLimitCard.subtitleResetTomorrow"
            return i18n.t(key, { time })
          })()}
        </Show>
      </CardDescription>
      <CardActions>
        <a
          class="rate-limit-card__action rate-limit-card__action--primary"
          href="#"
          data-slot="rate-limit-card-subscribe"
          onClick={(e) => {
            e.preventDefault()
            props.onSubscribeClick()
          }}
        >
          {i18n.t("ui.rateLimitCard.actionSubscribe")}
          <span class="rate-limit-card__external" aria-hidden="true">↗</span>
        </a>
        <a
          class="rate-limit-card__action"
          href="#"
          data-slot="rate-limit-card-byo"
          onClick={(e) => {
            e.preventDefault()
            props.onUseOwnModelClick()
          }}
        >
          {i18n.t("ui.rateLimitCard.actionBYO")}
        </a>
      </CardActions>
    </Card>
  )
}
