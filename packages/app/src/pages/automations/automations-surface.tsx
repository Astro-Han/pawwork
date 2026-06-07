import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { workspaceKey } from "@/pages/layout/helpers"
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

type AutomationItem = {
  definition: AutomationDefinition
  directory: string
  projectName: string
}

export function AutomationsSurface(props: {
  directory: Accessor<string>
  projectID: Accessor<string | undefined>
  requestedID?: Accessor<string | undefined>
  onClose: () => void
  onOpenRun: (sessionID: string) => void
  onCreateViaChat: () => void
}): JSX.Element {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const layout = useLayout()
  const dialog = useDialog()
  const [selectedID, setSelectedID] = createSignal<string | undefined>()

  // A pending deep-link selection (the automate tool's "open in Automations"
  // jump) is tracked reactively rather than read once on mount, so it applies
  // whether the panel was freshly mounted or already open. Manual opens clear
  // the request first, so an empty request never overrides the current row.
  createEffect(() => {
    const requested = props.requestedID?.()
    if (requested) setSelectedID(requested)
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

  const automationDirectories = createMemo(() => {
    const directories: string[] = []
    const seen = new Set<string>()
    const add = (directory: string | undefined) => {
      if (!directory) return
      const key = workspaceKey(directory)
      if (seen.has(key)) return
      seen.add(key)
      directories.push(directory)
    }

    for (const project of layout.projects.list()) {
      if (project.id === "global") continue
      add(project.worktree)
    }
    add(props.directory())
    return directories
  })

  const automationItems = createMemo(() => {
    const items: AutomationItem[] = []
    for (const directory of automationDirectories()) {
      const [store] = globalSync.child(directory)
      for (const definition of Object.values(store.automation)) {
        items.push({ definition, directory, projectName: getFilename(directory) })
      }
    }
    return items.sort((a, b) =>
      a.definition.updatedAt !== b.definition.updatedAt
        ? b.definition.updatedAt - a.definition.updatedAt
        : a.definition.id < b.definition.id
          ? 1
          : -1,
    )
  })

  const itemForAutomation = (id: string) => automationItems().find((item) => item.definition.id === id)

  const selected = createMemo(() => {
    const id = selectedID()
    if (!id) return undefined
    return itemForAutomation(id)
  })

  const toggleActive = async (automation: AutomationDefinition) => {
    const item = itemForAutomation(automation.id)
    if (!item) return
    try {
      if (automation.paused) await globalSync.automation.resume(item.directory, automation.id)
      else await globalSync.automation.pause(item.directory, automation.id)
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
    dialog.show(() => (
      <AutomationCreateDialog
        directory={directory}
        projectID={projectID}
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
                <Popover gutter={6} placement="bottom-end">
                  <Popover.Trigger as={Button} variant="primary" icon="plus-small" data-action="automation-create-open">
                    {language.t("automations.create.cta")}
                    <Icon name="chevron-down" />
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      data-component="dropdown-menu-content"
                      class="z-50 w-56 rounded-xl border border-border-weak bg-bg-base p-1.5 shadow-lg outline-none"
                    >
                      <Popover.CloseButton
                        data-action="automation-create-chat"
                        onClick={() => props.onCreateViaChat()}
                        class="flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
                      >
                        <Icon name="new-session" class="size-4 shrink-0 text-icon-weak" />
                        <span class="truncate">{language.t("automations.create.viaChat")}</span>
                      </Popover.CloseButton>
                      <Popover.CloseButton
                        data-action="automation-create-manual"
                        onClick={() => openCreate()}
                        class="flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
                      >
                        <Icon name="edit" class="size-4 shrink-0 text-icon-weak" />
                        <span class="truncate">{language.t("automations.create.manually")}</span>
                      </Popover.CloseButton>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover>
              </div>
              <Show when={automationItems().length > 0} fallback={<AutomationsEmpty onUseTemplate={openCreate} />}>
                <AutomationList items={automationItems} onSelect={setSelectedID} onToggleActive={toggleActive} />
              </Show>
            </div>
          }
        >
          {(item) => (
            <AutomationDetail
              automation={() => item().definition}
              directory={() => item().directory}
              onBack={() => setSelectedID(undefined)}
              onOpenRun={props.onOpenRun}
            />
          )}
        </Show>
      </div>
    </section>
  )
}
