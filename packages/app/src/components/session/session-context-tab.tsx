import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@opencode-ai/util/encode"
import { findLast } from "@opencode-ai/util/array"
import { same } from "@/utils/same"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { File } from "@opencode-ai/ui/file"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Progress } from "@opencode-ai/ui/progress"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { emptyMessages, emptyUserMessages, readSessionMessages, readUserMessages } from "@/pages/session/session-messages"
import { getRecentTurnCache, getSessionCacheAggregate, getSessionContextMetrics } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"
import { contextBudgetMarkerPercent, contextUsageTone } from "../session-context-usage-state"

type CacheTally = { input: number; read: number; write: number; hitRate: number | null }

// brand-primary alpha ladder. Hardcoded rgba (not color-mix(..., transparent)) per PawWork pierre
// convention — Safari's non-premultiplied interpolation can shift the apparent hue. syntax-* tokens
// are reserved for code highlighting, so they are not an option here (DESIGN.md).
const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "rgba(255, 89, 16, 0.30)",
  user: "var(--brand-primary)",
  assistant: "rgba(255, 89, 16, 0.70)",
  tool: "rgba(255, 89, 16, 0.45)",
  other: "rgba(255, 89, 16, 0.18)",
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

function cacheHitRateClass(value: number | null | undefined) {
  if (value === undefined || value === null) return "text-fg-strong"
  if (value >= 90) return "text-success-text"
  if (value >= 50) return "text-warning-text"
  return "text-error-text"
}

function MetricRow(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-3 min-h-[26px]">
      <div class="text-body text-fg-weak min-w-0 truncate">{props.label}</div>
      <div class="text-body text-fg-base tabular-nums shrink-0">{props.value}</div>
    </div>
  )
}

function LegendRow(props: { color: string; label: string; value: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-3 min-h-[26px]">
      <div class="flex items-center gap-2 min-w-0">
        <div class="size-2 rounded-sm shrink-0" style={{ "background-color": props.color }} />
        <div class="text-body text-fg-weak truncate">{props.label}</div>
      </div>
      <div class="text-body text-fg-base tabular-nums shrink-0">{props.value}</div>
    </div>
  )
}

function StackedBar(props: { segments: { color: string; width: number }[] }) {
  return (
    <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
      <For each={props.segments}>
        {(segment) => (
          <Show when={segment.width > 0}>
            <div class="h-full" style={{ width: `${segment.width}%`, "background-color": segment.color }} />
          </Show>
        )}
      </For>
    </div>
  )
}

// Budget meter — the house Progress bar carries the used percent; its fill tone escalates brand →
// warning → error in step with the composer usage ring (session-context-usage.tsx) via the
// --progress-fill custom property, so the whole app signals context pressure the same way. The quiet
// tick is the auto-compaction threshold, kept as a thin overlay since a generic Progress has no
// marker concept; the bare track beyond it is the headroom that remains.
function BudgetMeter(props: { label: string; usedPercent: number; markerPercent?: number; color: string }) {
  const used = () => clampPercent(props.usedPercent)
  const marker = () => (props.markerPercent === undefined ? undefined : clampPercent(props.markerPercent))
  return (
    <div class="relative">
      <Progress
        value={used()}
        aria-label={props.label}
        getValueLabel={({ value }) => `${Math.round(value)}%`}
        style={{ "--progress-fill": props.color }}
      />
      <Show when={marker() !== undefined}>
        <div
          class="absolute inset-y-0 w-px bg-[var(--fg-weak)]"
          style={{ left: `${marker()}%`, transform: "translateX(-50%)" }}
        />
      </Show>
    </div>
  )
}

// Plain titled section — no frame, no collapse. The panel's fixed-size groups (cache, token sources,
// model) are always about one screen, so a collapse affordance would be needless chrome (Occam's razor).
function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-3">
      <span class="text-h3 text-fg-strong">{props.title}</span>
      {props.children}
    </div>
  )
}

// Foldable section — reserved for unbounded content (the full system prompt, the raw message dump) that
// would otherwise blow past one screen. Borderless ghost Collapsible the message thread already uses
// (context-tool-group.tsx), collapsed by default, with a count/meta beside the title so the summary
// survives while collapsed.
function FoldSection(props: { title: string; meta?: JSX.Element; children: JSX.Element }) {
  return (
    <Collapsible variant="ghost">
      <Collapsible.Trigger>
        <div class="flex items-center justify-between gap-3 w-full">
          <span class="text-h3 text-fg-strong truncate">{props.title}</span>
          <div class="flex items-center gap-1 shrink-0 text-fg-weak">
            <Show when={props.meta}>
              <span class="text-caption tabular-nums truncate max-w-[18ch]">{props.meta}</span>
            </Show>
            <Collapsible.Arrow />
          </div>
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div class="pb-1 flex flex-col gap-3">{props.children}</div>
      </Collapsible.Content>
    </Collapsible>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Collapsible variant="ghost">
      <Collapsible.Trigger>
        <div class="flex items-center justify-between gap-2 w-full text-body">
          <div class="min-w-0 truncate">
            {props.message.role} <span class="text-fg-weak">{props.message.id}</span>
          </div>
          <div class="flex items-center gap-1 shrink-0 text-fg-weak">
            <span class="text-caption">{props.time(props.message.time.created)}</span>
            <Collapsible.Arrow />
          </div>
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div class="pb-2">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const providers = useProviders()
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      return readSessionMessages(id ? sync.data.message[id] : undefined)
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => readUserMessages(messages()),
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const metrics = createMemo(() => getSessionContextMetrics(messages(), providers.all(), sync.data.config))
  const ctx = createMemo(() => metrics().context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => usd().format(metrics().totalCost))

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return { all: all.length, user, assistant }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => ctx()?.providerLabel ?? "—")
  const modelLabel = createMemo(() => ctx()?.modelLabel ?? "—")

  const recentTurnCache = createMemo<CacheTally | null>(() =>
    getRecentTurnCache(messages(), info()?.revert?.messageID),
  )
  const sessionCache = createMemo<CacheTally | null>(() =>
    getSessionCacheAggregate(messages(), info()?.revert?.messageID),
  )

  // Budget hero — the one number that decides whether the session is about to compact.
  const budgetValue = createMemo(() => formatter().percent(ctx()?.usage))
  const budgetUsedOverLimit = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    const used = formatter().number(c.usedTokens)
    return c.effectiveInputLimit ? `${used} / ${formatter().number(c.effectiveInputLimit)}` : used
  })
  const budgetUsedPercent = createMemo(() => ctx()?.usagePercent ?? null)
  const budgetMarkerPercent = createMemo(() => {
    const c = ctx()
    if (!c) return undefined
    return contextBudgetMarkerPercent(c)
  })
  const budgetTone = createMemo(() => contextUsageTone(ctx()?.usagePercent))
  const budgetColor = createMemo(() => {
    const tone = budgetTone()
    if (tone === "danger") return "var(--error)"
    if (tone === "warning") return "var(--warning)"
    return "var(--brand-primary)"
  })
  // Right-hand note under the rail: headroom (tokens) before auto-compaction fires. The bare track to
  // the right of the fill shows the same headroom visually. Falls back to the off state when disabled.
  const compactNote = createMemo(() => {
    const c = ctx()
    if (!c) return ""
    if (!c.autoCompactEnabled) return language.t("context.usage.autoCompactOff")
    if (c.compactThreshold === undefined) return ""
    const headroom = Math.max(0, c.compactThreshold - c.usedTokens)
    return language.t("context.budget.toCompact", { amount: formatter().number(headroom) })
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync.data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const cacheRows = [
    { label: "context.cache.read", value: (tally: CacheTally | null) => formatter().number(tally?.read) },
    { label: "context.cache.new", value: (tally: CacheTally | null) => formatter().number(tally?.input) },
    { label: "context.cache.write", value: (tally: CacheTally | null) => formatter().number(tally?.write) },
  ] satisfies { label: string; value: (tally: CacheTally | null) => JSX.Element }[]

  const modelRows = [
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.contextWindow", value: () => formatter().number(ctx()?.contextWindow) },
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(ctx()?.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(ctx()?.reasoning) },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync.data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  const cacheCell = (tally: CacheTally | null, render: (tally: CacheTally | null) => JSX.Element, tone?: boolean) => (
    <div class={`text-body text-right tabular-nums ${tone ? cacheHitRateClass(tally?.hitRate) : "text-fg-base"}`}>
      {render(tally)}
    </div>
  )

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-4 pt-4 pb-10 flex flex-col gap-5">
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-caption text-fg-weak">{language.t("context.budget.title")}</span>
              <span class="text-h1 text-fg-strong tabular-nums">{budgetValue()}</span>
            </div>
            <Show
              when={budgetUsedPercent() !== null}
              fallback={<div class="text-body text-fg-weaker">{language.t("context.budget.empty")}</div>}
            >
              <BudgetMeter
                label={language.t("context.budget.title")}
                usedPercent={budgetUsedPercent() ?? 0}
                markerPercent={budgetMarkerPercent()}
                color={budgetColor()}
              />
              <div class="flex items-baseline justify-between gap-3 text-caption text-fg-weaker tabular-nums">
                <span>{budgetUsedOverLimit()}</span>
                <Show when={compactNote()}>
                  <span class="shrink-0">{compactNote()}</span>
                </Show>
              </div>
            </Show>
          </div>

          <div class="flex items-baseline justify-between gap-3">
            <span class="text-caption text-fg-weak">{language.t("context.stats.totalCost")}</span>
            <span class="text-body text-fg-strong tabular-nums">{cost()}</span>
          </div>
        </div>

        <Section title={language.t("context.section.cache")}>
          <Show
            when={recentTurnCache() || sessionCache()}
            fallback={<div class="text-body text-fg-weaker">{language.t("context.cache.empty")}</div>}
          >
            <div class="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1.5 items-baseline">
              <div />
              <div class="text-caption text-fg-weak text-right">{language.t("context.cache.turn")}</div>
              <div class="text-caption text-fg-weak text-right">{language.t("context.cache.session")}</div>

              <div class="text-body text-fg-weak">{language.t("context.cache.hitRate")}</div>
              {cacheCell(recentTurnCache(), (t) => formatter().percent(t?.hitRate, 1), true)}
              {cacheCell(sessionCache(), (t) => formatter().percent(t?.hitRate, 1), true)}

              <For each={cacheRows}>
                {(row) => (
                  <>
                    <div class="text-body text-fg-weak">
                      {language.t(row.label as Parameters<typeof language.t>[0])}
                    </div>
                    {cacheCell(recentTurnCache(), row.value)}
                    {cacheCell(sessionCache(), row.value)}
                  </>
                )}
              </For>
            </div>
          </Show>
        </Section>

        <Show when={breakdown().length > 0}>
          <Section title={language.t("context.section.sources")}>
            <StackedBar
              segments={breakdown().map((segment) => ({ color: BREAKDOWN_COLOR[segment.key], width: segment.width }))}
            />
            <div class="flex flex-col">
              <For each={breakdown()}>
                {(segment) => (
                  <LegendRow
                    color={BREAKDOWN_COLOR[segment.key]}
                    label={breakdownLabel(segment.key)}
                    value={`${segment.percent.toLocaleString(language.intl())}%`}
                  />
                )}
              </For>
            </div>
          </Section>
        </Show>

        <Section title={language.t("context.section.model")}>
          <div class="flex flex-col">
            <For each={modelRows}>
              {(row) => <MetricRow label={language.t(row.label as Parameters<typeof language.t>[0])} value={row.value()} />}
            </For>
          </div>
        </Section>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <FoldSection title={language.t("context.systemPrompt.title")}>
              <Markdown text={prompt()} class="text-body" />
            </FoldSection>
          )}
        </Show>

        <FoldSection title={language.t("context.rawMessages.title")} meta={counts().all.toLocaleString(language.intl())}>
          <div class="flex flex-col">
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </div>
        </FoldSection>
      </div>
    </ScrollView>
  )
}
