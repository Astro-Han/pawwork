import { createMemo, createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { formatServerError } from "@/utils/server-errors"
import { AutomationList } from "./automation-list"
import { AutomationDetail } from "./automation-detail"
import { AutomationCreateDialog } from "./automation-create-dialog"
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automation-templates"

function AutomationsEmpty(props: { onUseTemplate: (template: AutomationTemplate) => void }): JSX.Element {
  const language = useLanguage()
  return (
    <div data-component="automations-empty" class="flex flex-col items-center gap-5 px-6 py-16 text-center">
      <span class="flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle">
        <Icon name="schedule" class="h-6 w-6 text-icon-weak" />
      </span>
      <div class="text-h3 text-fg-strong">{language.t("automations.empty.title")}</div>
      <div class="flex flex-wrap items-center justify-center gap-2">
        {AUTOMATION_TEMPLATES.map((template) => (
          <button
            type="button"
            data-action="automation-template"
            data-template={template.id}
            onClick={() => props.onUseTemplate(template)}
            class="flex h-9 items-center gap-2 rounded-lg border border-border-weak bg-bg-base px-3.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
          >
            <Icon name={template.icon as never} class="size-4 text-icon-weak" />
            {language.t(template.titleKey)}
          </button>
        ))}
      </div>
    </div>
  )
}

export function AutomationsSurface(props: {
  directory: Accessor<string>
  projectID: Accessor<string | undefined>
  onClose: () => void
  onOpenRun: (sessionID: string) => void
}): JSX.Element {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const providers = useProviders()
  const [selectedID, setSelectedID] = createSignal<string | undefined>()

  // The panel renders outside the per-directory LocalProvider, so the create
  // card can't reuse the composer model state; seed it with the project's
  // default model (providerID -> modelID map) instead.
  const defaultModel = createMemo(() => {
    const defaults = providers.default()
    for (const providerID in defaults) {
      const modelID = defaults[providerID]
      if (modelID) return { providerID, modelID }
    }
    return undefined
  })

  // Escape returns to the list when a row is open, otherwise closes the surface.
  // The capture listener bails while a transient overlay is open; unlike the
  // settings takeover, the sidebar stays live here, so its dropdown/context
  // menus must get Escape first instead of being preempted into closing us.
  onMount(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (
        document.querySelector(
          '[data-component="dialog-overlay"], [data-component="select-content"], [data-component="dropdown-menu-content"], [data-component="context-menu-content"]',
        )
      )
        return
      event.preventDefault()
      if (selectedID()) {
        setSelectedID(undefined)
        return
      }
      props.onClose()
    }
    document.addEventListener("keydown", onEscape, true)
    onCleanup(() => document.removeEventListener("keydown", onEscape, true))
  })

  const automations = createMemo(() => {
    const directory = props.directory()
    if (!directory) return []
    const [store] = globalSync.child(directory, { bootstrap: false })
    return Object.values(store.automation).sort((a, b) =>
      a.updatedAt !== b.updatedAt ? b.updatedAt - a.updatedAt : a.id < b.id ? 1 : -1,
    )
  })

  const selected = createMemo(() => {
    const id = selectedID()
    if (!id) return undefined
    return automations().find((automation) => automation.id === id)
  })

  const toggleActive = async (automation: AutomationDefinition) => {
    const directory = props.directory()
    if (!directory) return
    try {
      if (automation.paused) await globalSync.automation.resume(directory, automation.id)
      else await globalSync.automation.pause(directory, automation.id)
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("automations.toast.actionFailed.title"),
        description: formatServerError(error, language.t),
      })
    }
  }

  const openCreate = (template?: AutomationTemplate) => {
    const projectID = props.projectID()
    if (!projectID) return
    const directory = props.directory()
    const model = defaultModel()
    dialog.show(() => (
      <AutomationCreateDialog
        directory={directory}
        projectID={projectID}
        model={model}
        template={template}
        onCreated={(definition) => setSelectedID(definition.id)}
      />
    ))
  }

  return (
    <section
      data-component="automations-page"
      aria-label={language.t("automations.title")}
      class="no-scrollbar size-full overflow-y-auto bg-bg-base"
    >
      <div class="mx-auto w-full max-w-[760px] px-6 py-6">
        <Show
          when={selected()}
          fallback={
            <div class="flex flex-col gap-4">
              <div class="flex items-center justify-end">
                <Button variant="primary" icon="plus" data-action="automation-create-open" onClick={() => openCreate()}>
                  {language.t("automations.create.cta")}
                </Button>
              </div>
              <Show when={automations().length > 0} fallback={<AutomationsEmpty onUseTemplate={openCreate} />}>
                <AutomationList automations={automations} onSelect={setSelectedID} onToggleActive={toggleActive} />
              </Show>
            </div>
          }
        >
          {(automation) => (
            <AutomationDetail
              automation={automation}
              directory={props.directory}
              onBack={() => setSelectedID(undefined)}
              onOpenRun={props.onOpenRun}
            />
          )}
        </Show>
      </div>
    </section>
  )
}
