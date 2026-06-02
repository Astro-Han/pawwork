import { createMemo, createSignal, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { formatServerError } from "@/utils/server-errors"
import { AutomationList } from "./automation-list"
import { AutomationDetail } from "./automation-detail"

function AutomationsEmpty(): JSX.Element {
  const language = useLanguage()
  return (
    <div data-component="automations-empty" class="flex flex-col items-center gap-3 px-6 py-20 text-center">
      <span class="flex h-10 w-10 items-center justify-center rounded-full bg-bg-subtle">
        <Icon name="schedule" class="h-5 w-5 text-icon-weak" />
      </span>
      <div class="flex flex-col gap-1">
        <div class="text-h3 text-fg-strong">{language.t("automations.empty.title")}</div>
        <p class="max-w-[360px] text-body text-fg-weak">{language.t("automations.empty.description")}</p>
      </div>
    </div>
  )
}

export function AutomationsSurface(props: {
  directory: Accessor<string>
  onClose: () => void
  onOpenRun: (sessionID: string) => void
}): JSX.Element {
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const [selectedID, setSelectedID] = createSignal<string | undefined>()

  // Escape returns to the list when a row is open, otherwise closes the surface.
  // Mirrors the settings takeover, and bails while a transient overlay is open.
  onMount(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (document.querySelector('[data-component="dialog-overlay"], [data-component="select-content"]')) return
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
            <Show when={automations().length > 0} fallback={<AutomationsEmpty />}>
              <AutomationList automations={automations} onSelect={setSelectedID} onToggleActive={toggleActive} />
            </Show>
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
