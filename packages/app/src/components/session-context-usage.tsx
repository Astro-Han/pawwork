import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@opencode-ai/ui/tooltip"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { Button } from "@opencode-ai/ui/button"

import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useSessionLayout } from "@/pages/session/session-layout"
import { contextUsageRingPercent, contextUsageTone } from "./session-context-usage-state"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const language = useLanguage()
  const providers = useProviders()
  const { params, view } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const metrics = createMemo(() => getSessionContextMetrics(messages(), providers.all(), sync.data.config))
  const context = createMemo(() => metrics().context)
  const tone = createMemo(() => contextUsageTone(context()?.usage))
  const ringColor = createMemo(() => {
    if (tone() === "danger") return "var(--icon-error-base)"
    if (tone() === "warning") return "var(--icon-warning-base)"
    return "var(--border-active)"
  })
  const cost = createMemo(() =>
    new Intl.NumberFormat(language.intl(), {
      style: "currency",
      currency: "USD",
    }).format(metrics().totalCost),
  )

  const openContext = () => {
    if (!params.id) return
    view().sidePanel.toggleTab("context")
  }

  const circle = () => (
    <div class="flex items-center justify-center" style={{ "--progress-circle-progress": ringColor() }}>
      <ProgressCircle size={16} strokeWidth={2} percentage={contextUsageRingPercent(context()?.usage)} />
    </div>
  )

  const compactStatus = () => {
    const ctx = context()
    if (!ctx) return undefined
    if (ctx.effectiveInputLimit === undefined) return language.t("context.usage.limitUnknown")
    if (!ctx.autoCompactEnabled) return language.t("context.usage.autoCompactOff")
    if (ctx.compactThreshold === undefined) return undefined
    return language.t("context.usage.autoCompactsAround", {
      threshold: ctx.compactThreshold.toLocaleString(language.intl()),
    })
  }

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{language.t("context.usage.title")}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">
                {ctx().usedTokens.toLocaleString(language.intl())}
                {ctx().effectiveInputLimit !== undefined
                  ? ` / ${ctx().effectiveInputLimit?.toLocaleString(language.intl())}`
                  : ""}
              </span>
              <span class="text-text-invert-base">{language.t("context.usage.contextUsed")}</span>
            </div>
            <Show when={compactStatus()}>
              {(status) => <div class="text-text-invert-base">{status()}</div>}
            </Show>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{cost()}</span>
        <span class="text-text-invert-base">{language.t("context.usage.cost")}</span>
      </div>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-7 shrink-0 p-0 rounded-xl!"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
