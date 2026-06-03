import { Popover } from "@kobalte/core/popover"
import { createMemo, createSignal, For, type JSX } from "solid-js"
import type { AutomationCreateInput, AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { AutomationSchedulePicker } from "./automation-schedule-picker"
import { buildScheduleInput, DEFAULT_SCHEDULE, type ScheduleDraft } from "./automation-schedule-form"
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automation-templates"

const KNOB_CLASS =
  "flex h-[30px] items-center gap-1.5 rounded-lg border border-border-weak bg-bg-base px-2.5 text-body text-fg-base"

// Manual create card (issue #950 PR7). Title + prompt + a Project | Schedule |
// Model bottom bar; context, stop, and worktree are pinned to fresh / never /
// none (see handoff). The Automations surface renders outside the per-directory
// LocalProvider, so the composer model picker (which needs useLocal) can't be
// reused here; the model is the project default, resolved by the surface and
// shown read-only. A panel-local model/variant picker is a follow-up.
export function AutomationCreateDialog(props: {
  directory: string
  projectID: string
  model: { providerID: string; modelID: string } | undefined
  template?: AutomationTemplate
  onCreated: (definition: AutomationDefinition) => void
}): JSX.Element {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const t = language.t

  const [title, setTitle] = createSignal(props.template ? t(props.template.titleKey) : "")
  const [prompt, setPrompt] = createSignal(props.template ? t(props.template.promptKey) : "")
  const [schedule, setSchedule] = createSignal<ScheduleDraft>(props.template?.schedule ?? DEFAULT_SCHEDULE)
  const [creating, setCreating] = createSignal(false)

  const applyTemplate = (template: AutomationTemplate) => {
    setTitle(t(template.titleKey))
    setPrompt(t(template.promptKey))
    setSchedule(template.schedule)
  }

  const canCreate = createMemo(() => title().trim().length > 0 && prompt().trim().length > 0 && !!props.model)

  const create = async () => {
    const model = props.model
    if (creating() || !canCreate() || !model) return
    setCreating(true)
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      const scheduled = buildScheduleInput(schedule(), timezone, Date.now())
      const common = {
        title: title().trim(),
        prompt: prompt().trim(),
        context: "fresh" as const,
        where: { projectID: props.projectID },
        timezone,
        model,
      }
      const input: AutomationCreateInput =
        scheduled.kind === "oneshot"
          ? { kind: "oneshot", ...common, fireAt: scheduled.fireAt }
          : { kind: "recurring", ...common, rhythm: scheduled.rhythm, stop: { kind: "never" } }
      const definition = await globalSync.automation.create(props.directory, input)
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
    <Dialog fit class="w-full max-w-[660px] mx-auto">
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
              class="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-border-weak bg-bg-base px-3 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
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

        <div class="flex items-center gap-2 border-t border-border-weak pt-3">
          <div class="flex min-w-0 flex-1 items-center gap-2">
            <span class={`${KNOB_CLASS} min-w-0`} title={props.directory}>
              <Icon name="folder" class="size-4 shrink-0 text-icon-weak" />
              <span class="truncate">{getFilename(props.directory)}</span>
            </span>

            <AutomationSchedulePicker value={schedule()} onChange={setSchedule} t={t} />

            <span class={`${KNOB_CLASS} shrink-0`} title={`${props.model?.providerID ?? ""}/${props.model?.modelID ?? ""}`}>
              <Icon name="models" class="size-4 text-icon-weak" />
              <span class="max-w-[140px] truncate">{props.model?.modelID ?? t("dialog.model.select.title")}</span>
            </span>
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
