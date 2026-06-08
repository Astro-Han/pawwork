import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import type { AutomationDefinition, AutomationRun } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { getRelativeTime } from "@/utils/time"
import { DialogDeleteAutomation } from "@/components/dialog-delete-automation"
import { formatScheduleSummary, formatTimestamp } from "./automation-schedule"
import { RunStatusIcon, runStatusLabelKey } from "./automation-run-status"

const INITIAL_RUN_COUNT = 5

type Translate = (key: string, vars?: Record<string, string | number>) => string

function InfoRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="flex items-baseline justify-between gap-3">
      <span class="shrink-0 text-caption text-fg-weak">{props.label}</span>
      <span class="min-w-0 truncate text-right text-body text-fg-base">{props.value}</span>
    </div>
  )
}

function DetailGroup(props: { heading: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="flex flex-col gap-2">
      <h2 class="text-caption font-emphasis uppercase tracking-wide text-fg-weak">{props.heading}</h2>
      <div class="flex flex-col gap-1.5">{props.children}</div>
    </section>
  )
}

function PreviousRuns(props: {
  runs: AutomationRun[]
  t: Translate
  onOpenRun: (sessionID: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false)
  const visible = createMemo(() => (expanded() ? props.runs : props.runs.slice(0, INITIAL_RUN_COUNT)))
  return (
    <DetailGroup heading={props.t("automations.detail.previousRuns")}>
      <Show
        when={props.runs.length > 0}
        fallback={<span class="text-body text-fg-weak">{props.t("automations.detail.noRuns")}</span>}
      >
        <ul class="flex flex-col gap-0.5">
          <For each={visible()}>
            {(run) => {
              const label = props.t(runStatusLabelKey(run.state))
              const when = getRelativeTime(new Date(run.triggeredAt).toISOString(), props.t)
              return (
                <li>
                  <Show
                    when={run.sessionID}
                    fallback={
                      <div class="flex items-center gap-2 px-2 py-1.5">
                        <RunStatusIcon state={run.state} label={label} />
                        <span class="min-w-0 flex-1 truncate text-body text-fg-base">{label}</span>
                        <span class="shrink-0 text-caption text-fg-weak">{when}</span>
                      </div>
                    }
                  >
                    {(sessionID) => (
                      <button
                        type="button"
                        data-action="automation-run-open"
                        onClick={() => props.onOpenRun(sessionID())}
                        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay focus:outline-none"
                      >
                        <RunStatusIcon state={run.state} label={label} />
                        <span class="min-w-0 flex-1 truncate text-body text-fg-base">{label}</span>
                        <span class="shrink-0 text-caption text-fg-weak">{when}</span>
                      </button>
                    )}
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
        <Show when={!expanded() && props.runs.length > INITIAL_RUN_COUNT}>
          <button
            type="button"
            data-action="automation-runs-show-more"
            onClick={() => setExpanded(true)}
            class="self-start rounded-md px-2 py-1 text-caption text-fg-weak hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay focus:outline-none"
          >
            {props.t("automations.detail.showMore")}
          </button>
        </Show>
      </Show>
    </DetailGroup>
  )
}

export function AutomationDetail(props: {
  automation: Accessor<AutomationDefinition>
  directory: Accessor<string>
  projectName: Accessor<string>
  onBack: () => void
  onOpenRun: (sessionID: string) => void
}): JSX.Element {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const t = language.t
  const [busy, setBusy] = createSignal(false)

  // Reload whenever the shown automation changes, not just on mount: a deep-link
  // jump can swap props.automation in place without remounting (the detail Show is
  // non-keyed), and the next-run/last-run rows derive from runs(). Load only the
  // most recent page; the "Recent runs" heading scopes the list to that page, so
  // the returned nextCursor is intentionally not paged.
  createEffect(() => {
    void globalSync.automation.loadRuns(props.directory(), props.automation().id)
  })

  const runs = createMemo<AutomationRun[]>(() => {
    const directory = props.directory()
    if (!directory) return []
    const [store] = globalSync.child(directory, { bootstrap: false })
    const id = props.automation().id
    return Object.values(store.automation_run)
      .filter((run) => run.automationID === id)
      .sort((a, b) => b.triggeredAt - a.triggeredAt)
  })

  const lastRunLabel = createMemo(() => {
    const run = runs()[0]
    return run ? getRelativeTime(new Date(run.triggeredAt).toISOString(), t) : undefined
  })

  const nextRunLabel = createMemo(() => {
    const automation = props.automation()
    if (automation.paused) return undefined
    if (automation.kind === "recurring") {
      if (automation.nextFireAt == null) return undefined
      return formatTimestamp(automation.nextFireAt, automation.timezone)
    }
    // A one-shot is spent only once a run actually fired at or after its scheduled
    // time, matching the scheduler's hasRunTriggeredAtOrAfter(fireAt). A manual
    // "Run now" before fireAt does not consume it, so the next run still stands.
    if (runs().some((run) => run.triggeredAt >= automation.fireAt)) return undefined
    return formatTimestamp(automation.fireAt, automation.timezone)
  })

  const reasoningLabel = createMemo(() => props.automation().variant)

  // Whether each run reuses the automation's own persistent session ("continue")
  // or starts a new one ("fresh"). The field is on every definition; surface it
  // so a continue automation reads as one that accumulates context across runs.
  const sessionLabel = createMemo(() =>
    props.automation().context === "continue"
      ? t("automations.detail.session.continue")
      : t("automations.detail.session.fresh"),
  )

  const notifyFailure = (error: unknown) => {
    showToast({
      variant: "error",
      title: t("automations.toast.actionFailed.title"),
      description: formatServerError(error, t),
    })
  }

  const runNow = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await globalSync.automation.runNow(props.directory(), props.automation().id)
    } catch (error) {
      notifyFailure(error)
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async () => {
    if (busy()) return
    const automation = props.automation()
    setBusy(true)
    try {
      if (automation.paused) await globalSync.automation.resume(props.directory(), automation.id)
      else await globalSync.automation.pause(props.directory(), automation.id)
    } catch (error) {
      notifyFailure(error)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = () => {
    const automation = props.automation()
    dialog.show(() => (
      <DialogDeleteAutomation
        title={automation.title}
        onConfirm={async () => {
          try {
            await globalSync.automation.delete(props.directory(), automation.id)
            props.onBack()
          } catch (error) {
            notifyFailure(error)
            throw error
          }
        }}
      />
    ))
  }

  return (
    <div data-component="automation-detail" class="flex flex-col gap-6">
      <nav class="flex items-center gap-1 text-body text-fg-weak">
        <button
          type="button"
          data-action="automation-detail-back"
          onClick={props.onBack}
          class="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay focus:outline-none"
        >
          <Icon name="chevron-left" class="w-3.5 h-3.5 text-icon-weak" />
          {t("automations.title")}
        </button>
      </nav>

      <header class="flex items-start justify-between gap-4">
        <h1 class="min-w-0 truncate text-h2 text-fg-strong">{props.automation().title}</h1>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            icon="trash"
            data-action="automation-delete"
            aria-label={t("automations.action.delete")}
            onClick={confirmDelete}
            disabled={busy()}
          />
          <Button
            variant="ghost"
            icon={props.automation().paused ? "play" : "pause"}
            data-action="automation-toggle-active"
            aria-label={props.automation().paused ? t("automations.action.resume") : t("automations.action.pause")}
            onClick={toggleActive}
            disabled={busy()}
          />
          <Button variant="primary" icon="play" data-action="automation-run-now" onClick={runNow} disabled={busy()}>
            {t("automations.action.runNow")}
          </Button>
        </div>
      </header>

      <div class="grid grid-cols-[minmax(0,1fr)_240px] gap-8">
        <section class="flex flex-col gap-2">
          <h2 class="text-caption font-emphasis uppercase tracking-wide text-fg-weak">
            {t("automations.detail.instructions")}
          </h2>
          <p class="whitespace-pre-wrap text-body text-fg-base">{props.automation().prompt}</p>
        </section>

        <aside class="flex flex-col gap-5">
          <DetailGroup heading={t("automations.detail.statusHeading")}>
            <InfoRow
              label={t("automations.detail.statusHeading")}
              value={props.automation().paused ? t("automations.detail.paused") : t("automations.detail.active")}
            />
            <Show when={nextRunLabel()}>
              {(value) => <InfoRow label={t("automations.detail.nextRun")} value={value()} />}
            </Show>
            <Show when={lastRunLabel()}>
              {(value) => <InfoRow label={t("automations.detail.lastRun")} value={value()} />}
            </Show>
          </DetailGroup>

          <DetailGroup heading={t("automations.detail.detailsHeading")}>
            <InfoRow label={t("automations.detail.project")} value={props.projectName()} />
            <InfoRow label={t("automations.detail.repeats")} value={formatScheduleSummary(props.automation(), t)} />
            <InfoRow label={t("automations.detail.session")} value={sessionLabel()} />
            <InfoRow label={t("automations.detail.model")} value={props.automation().model.modelID} />
            <Show when={reasoningLabel()}>
              {(value) => <InfoRow label={t("automations.detail.reasoning")} value={value()} />}
            </Show>
          </DetailGroup>

          <PreviousRuns runs={runs()} t={t} onOpenRun={props.onOpenRun} />
        </aside>
      </div>
    </div>
  )
}
