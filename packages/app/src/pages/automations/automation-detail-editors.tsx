import { createEffect, createMemo, createSignal, Show, type Accessor, type JSX } from "solid-js"
import type { AutomationDefinition, AutomationUpdateInput } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelSelectorPopover, type ModelPickerState } from "@/components/prompt-input/model-picker"
import { useScopedModels } from "@/context/models"
import type { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { AutomationFolderPicker, type AutomationProject } from "./automation-folder-picker"
import { AutomationScheduleControls } from "./automation-schedule-controls"
import {
  buildScheduleInput,
  cronForSchedule,
  scheduleDraftFromDefinition,
  DEFAULT_SCHEDULE,
  type ScheduleDraft,
  type ScheduleFrequency,
} from "./automation-schedule-form"
import { formatScheduleSummary } from "./automation-schedule"

type Translate = ReturnType<typeof useLanguage>["t"]

// Each edit commits its own one-field patch (resolved true on success); there
// is no edit mode and no save button. Failure rolls the control back to the
// definition, which the store still holds unchanged.
export type CommitPatch = (patch: AutomationUpdateInput) => Promise<boolean>

// The detail title / instructions rendered as a transparent always-editable
// control: blur commits when changed and non-empty, Escape or an empty value
// reverts. The DOM input owns the text while focused so an SSE refresh never
// stomps a half-typed edit.
export function EditableText(props: {
  value: string
  onCommit: (next: string) => Promise<boolean>
  multiline?: boolean
  class: string
  ariaLabel: string
  action: string
}): JSX.Element {
  let element: HTMLInputElement | HTMLTextAreaElement | undefined

  const autoresize = () => {
    if (!props.multiline || !element) return
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }

  createEffect(() => {
    const value = props.value
    if (!element || document.activeElement === element) return
    element.value = value
    autoresize()
  })

  const commit = async () => {
    if (!element) return
    const next = element.value.trim()
    if (!next || next === props.value) {
      element.value = props.value
      autoresize()
      return
    }
    const ok = await props.onCommit(next)
    // Roll back only if the control still shows the failed submission — the
    // user may have refocused and retyped while the request was in flight.
    if (!ok && element && element.value === next) {
      element.value = props.value
      autoresize()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (element) element.value = props.value
      autoresize()
      element?.blur()
      return
    }
    if (event.key === "Enter" && !props.multiline) element?.blur()
  }

  const shared = {
    "aria-label": props.ariaLabel,
    "data-action": props.action,
    class: `${props.class} bg-transparent focus:outline-none`,
    onBlur: () => void commit(),
    onKeyDown,
  }

  return (
    <Show
      when={props.multiline}
      fallback={<input type="text" ref={(el) => (element = el)} value={props.value} {...shared} />}
    >
      <textarea
        ref={(el) => {
          element = el
          queueMicrotask(autoresize)
        }}
        value={props.value}
        rows={1}
        onInput={autoresize}
        {...shared}
        class={`${props.class} resize-none bg-transparent focus:outline-none`}
      />
    </Show>
  )
}

const ROW_VALUE_CLASS =
  "h-[30px] min-w-0 truncate rounded-md px-2 text-right text-body text-fg-base hover:bg-row-hover-overlay hover:text-fg-strong focus-visible:bg-row-hover-overlay focus-visible:text-fg-strong focus:outline-none cursor-default"

function EditorRow(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex items-baseline justify-between gap-3">
      <span class="shrink-0 text-caption text-fg-weak">{props.label}</span>
      {props.children}
    </div>
  )
}

// The "Project" row moves fresh automations by updating their owner in place.
// A continue automation stays read-only because it loops inside a conversation
// that only exists in its source project. Fresh automations keep the picker
// clickable even with one project, so the user can open another project from
// this surface before moving it.
export function ProjectEditorRow(props: {
  directory: Accessor<string>
  automation: Accessor<AutomationDefinition>
  projectName: Accessor<string>
  t: Translate
  onMove: (project: AutomationProject) => void
  onOpenProject: () => void
}): JSX.Element {
  const layout = useLayout()
  const projects = createMemo<AutomationProject[]>(() =>
    layout.projects
      .list()
      .filter((project) => project.id && project.id !== "global" && project.worktree)
      .map((project) => ({ id: project.id!, worktree: project.worktree, name: project.name })),
  )
  const editable = createMemo(() => props.automation().context === "fresh" && projects().length > 0)
  return (
    <EditorRow label={props.t("automations.detail.project")}>
      <Show
        when={editable()}
        fallback={<span class="min-w-0 truncate text-right text-body text-fg-base">{props.projectName()}</span>}
      >
        <AutomationFolderPicker
          variant="row"
          action="automation-edit-project"
          projects={projects()}
          current={props.directory()}
          onSelect={(project) => props.onMove(project)}
          onOpenProject={props.onOpenProject}
        />
      </Show>
    </EditorRow>
  )
}

// The "Repeats" row: the summary text opens the create card's schedule controls
// in a popover. Every knob change commits immediately — each intermediate state
// is itself a valid schedule. The kind is fixed by the server (no
// oneshot<->recurring conversion), so the frequency switch only offers what the
// kind supports. A rhythm the picker cannot express (hourly, interval,
// arbitrary cron) renders read-only instead: the segmented switch would have
// to pre-select a frequency the definition does not have, and any knob change
// would silently rewrite the rhythm to it.
export function ScheduleEditorRow(props: {
  automation: Accessor<AutomationDefinition>
  t: Translate
  onPatch: CommitPatch
}): JSX.Element {
  const draftFromDefinition = (): ScheduleDraft => scheduleDraftFromDefinition(props.automation()) ?? DEFAULT_SCHEDULE
  const editable = createMemo(() => scheduleDraftFromDefinition(props.automation()) !== undefined)
  const [draft, setDraft] = createSignal<ScheduleDraft>(draftFromDefinition())
  createEffect(() => setDraft(draftFromDefinition()))

  const frequencies = (): ScheduleFrequency[] =>
    props.automation().kind === "oneshot" ? ["once"] : ["daily", "weekdays", "weekly"]

  const change = async (next: ScheduleDraft) => {
    setDraft(next)
    const definition = props.automation()
    const scheduled = buildScheduleInput(next, definition.timezone, Date.now())
    const ok = await props.onPatch(
      scheduled.kind === "oneshot"
        ? { fireAt: scheduled.fireAt }
        : { rhythm: { kind: "cron", expression: cronForSchedule(next) } },
    )
    if (!ok) setDraft(draftFromDefinition())
  }

  return (
    <EditorRow label={props.t("automations.detail.repeats")}>
      <Show
        when={editable()}
        fallback={
          <span class="min-w-0 truncate text-right text-body text-fg-base">
            {formatScheduleSummary(props.automation(), props.t)}
          </span>
        }
      >
        <Popover
        modal
        placement="bottom-end"
        class="w-max max-w-[440px]"
        triggerAs="button"
        triggerProps={
          {
            type: "button",
            "data-action": "automation-edit-schedule",
            "aria-label": props.t("automations.detail.repeats"),
            class: `flex min-w-0 items-center gap-1.5 ${ROW_VALUE_CLASS}`,
          } as never
        }
        trigger={
          <>
            <span class="min-w-0 truncate">{formatScheduleSummary(props.automation(), props.t)}</span>
            <Icon name="chevron-down" class="size-3 shrink-0 text-icon-weak" />
          </>
        }
      >
          <AutomationScheduleControls
            value={draft()}
            onChange={(next) => void change(next)}
            t={props.t}
            frequencies={frequencies()}
          />
        </Popover>
      </Show>
    </EditorRow>
  )
}

// The "Model" row reuses the composer's model picker. Picking a model clears
// the variant (thinking levels are model-specific); picking a thinking level
// patches the variant alone.
export function ModelEditorRow(props: {
  directory: Accessor<string>
  automation: Accessor<AutomationDefinition>
  t: Translate
  onPatch: CommitPatch
}): JSX.Element {
  const models = useScopedModels(props.directory)
  const current = () => {
    const model = props.automation().model
    return models.find({ providerID: model.providerID, modelID: model.modelID })
  }
  const state: ModelPickerState = {
    list: models.list,
    current,
    visible: (item) => models.visible(item),
    set: (item) => {
      if (!item) return
      models.setVisibility(item, true)
      void props.onPatch({ model: { providerID: item.providerID, modelID: item.modelID }, variant: null })
    },
    variant: {
      list: () => Object.keys(current()?.variants ?? {}),
      current: () => props.automation().variant,
      set: (value) => void props.onPatch({ variant: value ?? null }),
    },
  }

  return (
    <EditorRow label={props.t("automations.detail.model")}>
      <ModelSelectorPopover
        modal
        model={state}
        triggerProps={{
          "data-action": "automation-edit-model",
          "aria-label": props.t("automations.detail.model"),
          class: `flex min-w-0 items-center gap-1.5 ${ROW_VALUE_CLASS}`,
        }}
      >
        <Show when={current()} fallback={<span class="min-w-0 truncate">{props.automation().model.modelID}</span>}>
          {(selected) => (
            <>
              <ProviderIcon id={selected().provider.id} class="size-3.5 shrink-0 text-icon-weak" />
              <span class="min-w-0 truncate">{selected().name}</span>
            </>
          )}
        </Show>
        <Icon name="chevron-down" class="size-3 shrink-0 text-icon-weak" />
      </ModelSelectorPopover>
    </EditorRow>
  )
}
