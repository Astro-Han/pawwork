import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { RetryClassification } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card, CardActions, CardDescription, CardTitle } from "./card"
import "./rate-limit-card.css"

export interface RateLimitCardProps {
  classification: Extract<RetryClassification, { kind: "free_quota_exhausted" }>
  onSubscribeClick: () => void
  onUseOwnModelClick: () => void
}

// Exported for unit testing. Returns undefined when resetAt is in the past or
// more than one local calendar day away — those cases would yield misleading
// "today"/"tomorrow" copy, so the caller falls back to the no-time subtitle.
export function formatResetTime(
  resetAt: number,
  now: number = Date.now(),
): { time: string; kind: "today" | "tomorrow" } | undefined {
  if (resetAt <= now) return undefined
  const reset = new Date(resetAt)
  const today = new Date(now)
  const resetMidnight = new Date(reset.getFullYear(), reset.getMonth(), reset.getDate()).getTime()
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const diffDays = Math.round((resetMidnight - todayMidnight) / 86_400_000)
  if (diffDays !== 0 && diffDays !== 1) return undefined
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(reset)
  return { time, kind: diffDays === 0 ? "today" : "tomorrow" }
}

export function RateLimitCard(props: RateLimitCardProps) {
  const i18n = useI18n()
  // rate_limit_blocked is a sticky terminal state (see session/status.ts), so
  // the card stays mounted past resetAt unless the user starts a new turn.
  // Tick `now` once at resetAt so the "today"/"tomorrow" copy falls through to
  // the no-time subtitle instead of pointing at an already-elapsed time.
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const resetAt = props.classification.resetAt
    if (resetAt === undefined) return
    const remaining = resetAt - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), remaining + 1000)
    onCleanup(() => clearTimeout(timer))
  })
  const formatted = () => {
    const resetAt = props.classification.resetAt
    return resetAt === undefined ? undefined : formatResetTime(resetAt, now())
  }
  return (
    <Card variant="warning" data-slot="rate-limit-card" data-kind="rate-limit-card">
      <CardTitle variant="warning">{i18n.t("ui.rateLimitCard.title")}</CardTitle>
      <CardDescription>
        <Show when={formatted()} fallback={i18n.t("ui.rateLimitCard.subtitleNoTime")}>
          {(result) => {
            const r = result()
            const key =
              r.kind === "today" ? "ui.rateLimitCard.subtitleResetToday" : "ui.rateLimitCard.subtitleResetTomorrow"
            return i18n.t(key, { time: r.time })
          }}
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
