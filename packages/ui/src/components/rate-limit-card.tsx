import { createSignal, onCleanup, onMount } from "solid-js"
import type { RetryClassification } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card, CardActions } from "./card"
import "./rate-limit-card.css"

export interface RateLimitCardProps {
  classification: Extract<RetryClassification, { kind: "free_quota_exhausted" }>
  onSubscribeClick: () => void
  onDeepSeekClick: () => void
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
  const resetSubtitle = () => {
    const f = formatted()
    if (!f) return i18n.t("ui.rateLimitCard.subtitleNoTime")
    const key =
      f.kind === "today" ? "ui.rateLimitCard.subtitleResetToday" : "ui.rateLimitCard.subtitleResetTomorrow"
    return i18n.t(key, { time: f.time })
  }
  // The warning triangle that CardTitle would inject is redundant with the
  // 2px orange rule on the card's left edge — both encode the same warning
  // semantic. We drop CardTitle/CardDescription entirely and render a single
  // headline that folds title + reset onto one line via a middle-dot, then
  // hand the action ledger a grid of `[primary link, prerequisite note]`
  // rows so the two recommendations sit on aligned columns. The user picks by
  // matching their situation to the right-column prerequisite before clicking
  // the left-column brand link — the prerequisite is read first, not as a
  // skippable footnote.
  return (
    <Card variant="warning" data-slot="rate-limit-card" data-kind="rate-limit-card">
      <div class="rate-limit-card__head" data-slot="rate-limit-card-head">
        <span class="rate-limit-card__title">{i18n.t("ui.rateLimitCard.title")}</span>
        <span class="rate-limit-card__sep" aria-hidden="true">
          ·
        </span>
        <span class="rate-limit-card__reset">{resetSubtitle()}</span>
      </div>
      <CardActions>
        <a
          class="rate-limit-card__action"
          href="#"
          data-slot="rate-limit-card-subscribe"
          onClick={(e) => {
            e.preventDefault()
            props.onSubscribeClick()
          }}
        >
          {i18n.t("ui.rateLimitCard.actionSubscribe")}
          <span class="rate-limit-card__external" aria-hidden="true">
            ↗
          </span>
        </a>
        <span class="rate-limit-card__note">{i18n.t("ui.rateLimitCard.noteSubscribe")}</span>
        <a
          class="rate-limit-card__action"
          href="#"
          data-slot="rate-limit-card-deepseek"
          onClick={(e) => {
            e.preventDefault()
            props.onDeepSeekClick()
          }}
        >
          {i18n.t("ui.rateLimitCard.actionDeepSeek")}
          <span class="rate-limit-card__external" aria-hidden="true">
            ↗
          </span>
        </a>
        <span class="rate-limit-card__note">{i18n.t("ui.rateLimitCard.noteDeepSeek")}</span>
        <div class="rate-limit-card__byo-row">
          <a
            class="rate-limit-card__byo"
            href="#"
            data-slot="rate-limit-card-byo"
            onClick={(e) => {
              e.preventDefault()
              props.onUseOwnModelClick()
            }}
          >
            {i18n.t("ui.rateLimitCard.actionBYO")}
          </a>
        </div>
      </CardActions>
    </Card>
  )
}
