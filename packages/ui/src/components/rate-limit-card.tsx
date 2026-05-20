import { Show } from "solid-js"
import type { RetryClassification } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import "./rate-limit-card.css"

export interface RateLimitCardProps {
  classification: Extract<RetryClassification, { kind: "free_quota_exhausted" }>
  onSubscribeClick: () => void
  onUseOwnModelClick: () => void
}

// Exported for unit testing.
export function formatResetTime(resetAt: number): { time: string; tz: string } {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
    hour12: false,
  }).format(new Date(resetAt))
  return { time, tz }
}

export function RateLimitCard(props: RateLimitCardProps) {
  const i18n = useI18n()
  return (
    <div data-slot="rate-limit-card" class="rate-limit-card">
      <span class="rate-limit-card__icon" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
      <div class="rate-limit-card__body">
        <h3 class="rate-limit-card__title">{i18n.t("ui.rateLimitCard.title")}</h3>
        <p class="rate-limit-card__description">
          <Show
            when={props.classification.resetAt !== undefined}
            fallback={i18n.t("ui.rateLimitCard.subtitleNoTime")}
          >
            {(() => {
              const { time, tz } = formatResetTime(props.classification.resetAt!)
              return i18n.t("ui.rateLimitCard.subtitleWithTime", { time, tz })
            })()}
          </Show>
        </p>
        <div class="rate-limit-card__actions">
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
        </div>
      </div>
    </div>
  )
}
