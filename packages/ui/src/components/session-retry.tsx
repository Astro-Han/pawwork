import { createEffect, createMemo, createSignal, on, onCleanup, Show, type JSX } from "solid-js"
import type { RetryClassification, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../context/i18n"
import { Card } from "./card"
import { Tooltip } from "./tooltip"
import { Spinner } from "./spinner"

type FreeQuotaClassification = Extract<RetryClassification, { kind: "free_quota_exhausted" }>

/** Render-slot callback type for app-layer wiring to render RateLimitCard. */
export type SessionRetryRateLimitSlot = (classification: FreeQuotaClassification) => JSX.Element

export function SessionRetry(props: {
  status: SessionStatus
  show?: boolean
  /**
   * Optional render slot for the free-quota-exhausted state. App layer
   * provides RateLimitCardWiring here so packages/ui stays framework-agnostic.
   * If omitted, SessionRetry renders nothing for rate_limit_blocked status
   * (degraded but safe — the dispatch branch is exercised by E2E via the slot).
   */
  rateLimitCardSlot?: (classification: FreeQuotaClassification) => JSX.Element
}) {
  const i18n = useI18n()
  // Free-quota classification short-circuits the retry banner. Spec §6.1 + §5.5.
  const freeQuotaClassification = createMemo<FreeQuotaClassification | undefined>(() => {
    if (props.status.type === "rate_limit_blocked" && props.status.classification.kind === "free_quota_exhausted") {
      return props.status.classification
    }
    if (props.status.type === "retry" && props.status.classification?.kind === "free_quota_exhausted") {
      // Defensive: policy should stop before this path renders. See spec §6.1 fallback.
      return props.status.classification
    }
    return undefined
  })
  const retry = createMemo(() => {
    if (freeQuotaClassification()) return
    if (props.status.type !== "retry") return
    return props.status
  })
  const safeRecoveryRetry = createMemo(() => {
    const current = retry()
    if (current?.presentation !== "recovery" && current?.presentation !== "safe_recovery") return
    return current
  })
  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(retry, (current) => {
      if (!current) return
      const update = () => {
        const next = retry()?.next
        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }
      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const message = createMemo(() => {
    const current = retry()
    if (!current) return ""
    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }
    if (current.message.length > 80) return current.message.slice(0, 80) + "..."
    return current.message
  })
  const truncated = createMemo(() => {
    const current = retry()
    if (!current) return false
    return current.message.length > 80
  })
  const info = createMemo(() => {
    const current = retry()
    if (!current) return ""
    const count = Math.max(0, seconds())
    const delay = count > 0 ? i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) : ""
    const retrying = i18n.t("ui.sessionTurn.retry.retrying")
    const line = [retrying, delay].filter(Boolean).join(" ")
    if (!line) return i18n.t("ui.sessionTurn.retry.attempt", { attempt: current.attempt })
    return i18n.t("ui.sessionTurn.retry.attemptLine", { line, attempt: current.attempt })
  })

  return (
    <Show
      when={freeQuotaClassification()}
      fallback={
        <Show when={retry() && (props.show ?? true)}>
          <Show
            when={safeRecoveryRetry()}
            fallback={
              <div data-slot="session-turn-retry">
                <Card variant="error" class="error-card">
                  <div class="flex items-start gap-2">
                    <Spinner class="size-4 mt-0.5" />
                    <div class="min-w-0">
                      <Show when={truncated()} fallback={<div data-slot="session-turn-retry-message">{message()}</div>}>
                        <Tooltip value={retry()?.message ?? ""} placement="top">
                          <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                            {message()}
                          </div>
                        </Tooltip>
                      </Show>
                      <Show when={info()}>{(line) => <div data-slot="session-turn-retry-info">{line()}</div>}</Show>
                    </div>
                  </div>
                </Card>
              </div>
            }
          >
            {(current) => (
              <div data-slot="session-turn-safe-retry" class="flex items-center gap-2 text-caption text-fg-weak">
                <Spinner class="size-3.5" />
                <div data-slot="session-turn-safe-retry-message">
                  {current().attempt > 0
                    ? i18n.t("ui.sessionTurn.retry.recoveryAttempt", { attempt: current().attempt })
                    : i18n.t("ui.sessionTurn.retry.recovery")}
                </div>
              </div>
            )}
          </Show>
        </Show>
      }
    >
      {(classification) => <Show when={props.rateLimitCardSlot}>{(slot) => slot()(classification())}</Show>}
    </Show>
  )
}
