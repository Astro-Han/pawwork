import { Popover } from "@kobalte/core/popover"
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js"
import type { AutomationCreateInput, AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ModelSelectorPopover } from "@/components/prompt-input/model-picker"
import { translateVariant } from "@/components/prompt-input/variant-label"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useScopedModels, type ModelKey } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { formatServerError } from "@/utils/server-errors"
import { AutomationScheduleControls } from "./automation-schedule-controls"
import { AutomationFolderPicker, type AutomationProject } from "./automation-folder-picker"
import { buildScheduleInput, DEFAULT_SCHEDULE, type ScheduleDraft } from "./automation-schedule-form"
import { createAutomationModelState } from "./automation-model-state"
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automation-templates"

const KNOB_CLASS =
  "flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border border-border-weak px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none cursor-default"

// Manual create card (issue #950 PR7). Title + prompt, then an inline schedule
// row (frequency segmented switch + time), then a Folder | Model bottom bar.
// context, stop, and worktree are pinned to fresh / never / none (see handoff);
// the folder picker lets the automation be filed against any open project. The
// Automations surface renders outside the per-directory LocalProvider, so the
// composer's useLocal-backed model state can't be reused; a panel-local
// controller (see automation-model-state) drives the same picker UI from
// useModels(), seeded with the last-used / default model.
export function AutomationCreateDialog(props: {
  directory: string
  projectID: string
  template?: AutomationTemplate
  onOpenProject: () => void
  onCreated: (definition: AutomationDefinition) => void
}): JSX.Element {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const layout = useLayout()
  const dialog = useDialog()
  const t = language.t

  // The folder picker can file the automation against any open project, so the
  // model list, default and validation must follow the *selected* directory, not
  // the current route — otherwise we'd offer/seed a model the target project
  // can't run (#950 PR7 P1). Declared before the scoped model/provider views so
  // they react to folder switches.
  const [directory, setDirectory] = createSignal(props.directory)
  const [projectID, setProjectID] = createSignal(props.projectID)
  const models = useScopedModels(directory)
  const providers = useProviders(directory)

  // Open projects the automation can be filed against (excludes the synthetic
  // "global" project). Each carries the projectID the create input needs.
  const projects = createMemo<AutomationProject[]>(() =>
    layout.projects
      .list()
      .filter((project) => project.id && project.id !== "global" && project.worktree)
      .map((project) => ({ id: project.id!, worktree: project.worktree, name: project.name })),
  )

  // Seed with the same priority the composer uses: last-used model, then the
  // configured project default, then the first connected model. Resolved once;
  // the picker takes over from here.
  const seedModel = (): ModelKey | undefined => {
    for (const recent of models.recent.list()) if (models.find(recent)) return recent
    const defaults = providers.default()
    for (const providerID in defaults) {
      const modelID = defaults[providerID]
      if (modelID && models.find({ providerID, modelID })) return { providerID, modelID }
    }
    const first = models.list()[0]
    return first ? { providerID: first.provider.id, modelID: first.id } : undefined
  }

  const [title, setTitle] = createSignal(props.template ? t(props.template.titleKey) : "")
  const [prompt, setPrompt] = createSignal(props.template ? t(props.template.promptKey) : "")
  const [schedule, setSchedule] = createSignal<ScheduleDraft>(props.template?.schedule ?? DEFAULT_SCHEDULE)
  const [model, setModel] = createSignal<ModelKey | undefined>(seedModel())
  const [variant, setVariant] = createSignal<string | undefined>()
  const [creating, setCreating] = createSignal(false)

  // When the folder changes, the model list reflects the new project. If the
  // current pick isn't available there, re-seed (and drop the variant) so we
  // never submit a model the target project can't run.
  createEffect(
    on(directory, () => {
      const selected = model()
      if (selected && models.find(selected)) return
      setModel(seedModel())
      setVariant(undefined)
    }, { defer: true }),
  )

  const modelState = createAutomationModelState({ models, model, setModel, variant, setVariant })

  const applyTemplate = (template: AutomationTemplate) => {
    setTitle(t(template.titleKey))
    setPrompt(t(template.promptKey))
    setSchedule(template.schedule)
  }

  // The model must be valid for the *selected* project, not just set.
  const validModel = createMemo(() => {
    const selected = model()
    return selected ? models.find(selected) : undefined
  })

  const canCreate = createMemo(
    () => title().trim().length > 0 && prompt().trim().length > 0 && !!validModel() && !!projectID(),
  )

  const create = async () => {
    const selected = model()
    if (creating() || !canCreate() || !selected) return
    setCreating(true)
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      const scheduled = buildScheduleInput(schedule(), timezone, Date.now())
      const common = {
        title: title().trim(),
        prompt: prompt().trim(),
        context: "fresh" as const,
        where: { projectID: projectID() },
        timezone,
        model: selected,
        ...(variant() ? { variant: variant() } : {}),
      }
      const input: AutomationCreateInput =
        scheduled.kind === "oneshot"
          ? { kind: "oneshot", ...common, fireAt: scheduled.fireAt }
          : { kind: "recurring", ...common, rhythm: scheduled.rhythm, stop: { kind: "never" } }
      const definition = await globalSync.automation.create(directory(), input)
      dialog.close()
      if (definition) props.onCreated(definition)
    } catch (error) {
      showToast({
        variant: "error",
        title: t("automations.create.failed"),
        description: formatServerError(error, t),
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog fit class="w-full max-w-[600px] mx-auto">
      <div data-component="automation-create" class="flex flex-col gap-3 p-4">
        <div class="flex items-start gap-2">
          <input
            type="text"
            data-action="automation-create-title"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
            placeholder={t("automations.create.titlePlaceholder")}
            class="min-w-0 flex-1 bg-transparent text-h3 text-fg-strong placeholder:text-fg-weak focus:outline-none"
            autofocus
          />
          <Popover gutter={6} placement="bottom-end">
            <Popover.Trigger
              data-action="automation-use-template"
              class="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-border-weak px-3 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
            >
              {t("automations.create.useTemplate")}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                data-component="dropdown-menu-content"
                class="z-50 w-56 rounded-xl border border-border-weak bg-bg-base p-1.5 shadow-lg outline-none"
              >
                <For each={AUTOMATION_TEMPLATES}>
                  {(template) => (
                    <Popover.CloseButton
                      data-action="automation-template-option"
                      data-template={template.id}
                      onClick={() => applyTemplate(template)}
                      class="flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
                    >
                      <Icon name={template.icon as never} class="size-4 shrink-0 text-icon-weak" />
                      <span class="truncate">{t(template.titleKey)}</span>
                    </Popover.CloseButton>
                  )}
                </For>
              </Popover.Content>
            </Popover.Portal>
          </Popover>
          <button
            type="button"
            data-action="automation-create-close"
            aria-label={t("common.cancel")}
            onClick={() => dialog.close()}
            class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-fg-weak hover:bg-row-hover-overlay focus:outline-none"
          >
            <Icon name="close" class="size-4" />
          </button>
        </div>

        <textarea
          data-action="automation-create-prompt"
          value={prompt()}
          onInput={(event) => setPrompt(event.currentTarget.value)}
          placeholder={t("automations.create.promptPlaceholder")}
          rows={5}
          class="min-h-[132px] w-full resize-none bg-transparent text-body text-fg-base placeholder:text-fg-weak focus:outline-none"
        />

        <AutomationScheduleControls value={schedule()} onChange={setSchedule} t={t} />

        <div class="flex items-center gap-2 border-t border-border-weak pt-3">
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <AutomationFolderPicker
              projects={projects()}
              current={directory()}
              onOpenProject={props.onOpenProject}
              onSelect={(project) => {
                setDirectory(project.worktree)
                setProjectID(project.id)
              }}
            />

            <ModelSelectorPopover
              modal
              model={modelState}
              triggerProps={{
                "data-action": "automation-model-trigger",
                class: KNOB_CLASS,
              }}
            >
              <Show
                when={modelState.current()}
                fallback={
                  <>
                    <Icon name="models" class="size-4 shrink-0 text-icon-weak" />
                    <span>{t("dialog.model.select.title")}</span>
                  </>
                }
              >
                {(selected) => (
                  <>
                    <ProviderIcon id={selected().provider.id} class="size-4 shrink-0 text-icon-weak" />
                    <span class="min-w-0 truncate">{selected().name}</span>
                    <Show when={modelState.variant.current()}>
                      {(value) => <span class="shrink-0 text-fg-weak">{translateVariant(t, value())}</span>}
                    </Show>
                  </>
                )}
              </Show>
              <Icon name="chevron-down" class="shrink-0 text-icon-weak" />
            </ModelSelectorPopover>
          </div>

          <Button
            variant="ghost"
            class="shrink-0"
            data-action="automation-create-cancel"
            onClick={() => dialog.close()}
            disabled={creating()}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            class="shrink-0"
            data-action="automation-create-submit"
            onClick={create}
            disabled={!canCreate() || creating()}
          >
            {t("automations.create.submit")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
