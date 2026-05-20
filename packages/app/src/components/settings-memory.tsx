import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { createResource, createSignal, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { notifyMemoryStateChanged } from "./memory/memory-state-sync"
import { SettingsList } from "./settings-list"

type MemoryState = {
  path?: string
  disabled?: boolean
  status?: "ok" | "safe_mode"
  reason?: string
  content?: string
  profileTooLarge?: boolean
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

export function SettingsMemory(props: { directory?: string }) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const client = () => globalSDK.createClient({ directory: props.directory, throwOnError: true })
  const [draft, setDraft] = createSignal("")
  const [state, actions] = createResource(async () => {
    try {
      const result = await client().memory.get()
      const data = (result.data ?? {}) as MemoryState
      setDraft(data.content ?? "")
      return data
    } catch (error) {
      setDraft("")
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
      throw error
    }
  })

  const refresh = () => void actions.refetch()

  const save = async () => {
    try {
      await client().memory.update({ memoryRawInput: { content: draft() } })
      showToast({ variant: "success", title: language.t("settings.memory.saved") })
      refresh()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    }
  }

  const toggle = async (enabled: boolean) => {
    try {
      await client().memory.disabled({ memoryDisabledInput: { disabled: !enabled } })
      notifyMemoryStateChanged()
      refresh()
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    }
  }

  return (
    <div class="py-4">
      <SettingsList>
        <section class="flex flex-col gap-1 border-b border-border-weak py-3">
          <h2 class="text-h2 text-fg-strong">{language.t("settings.memory.title")}</h2>
          <p class="text-body text-fg-weak">{language.t("settings.memory.description")}</p>
          <Show when={state.latest?.path}>
            <p class="text-caption text-fg-weaker">{state.latest?.path}</p>
          </Show>
        </section>

        <section class="flex flex-wrap items-center gap-4 border-b border-border-weak py-3 sm:flex-nowrap">
          <div class="min-w-0 flex-1">
            <div class="text-h3 text-fg-strong">{language.t("settings.memory.enabled.title")}</div>
            <div class="text-body text-fg-weak">{language.t("settings.memory.enabled.description")}</div>
          </div>
          <Switch checked={!state.latest?.disabled} onChange={toggle} />
        </section>

        <Show when={state.latest?.status === "safe_mode"}>
          <section class="rounded border border-danger/40 bg-danger/5 p-3 text-body text-danger">
            {language.t("settings.memory.safeMode", { reason: state.latest?.reason ?? "" })}
          </section>
        </Show>

        <Show when={state.latest?.profileTooLarge}>
          <section class="rounded border border-border bg-surface-base p-3 text-body text-fg-weak">
            {language.t("settings.memory.profileTooLarge")}
          </section>
        </Show>

        <section class="flex flex-col gap-3 py-3">
          <div>
            <div class="text-h3 text-fg-strong">{language.t("settings.memory.raw.title")}</div>
            <div class="text-body text-fg-weak">{language.t("settings.memory.raw.description")}</div>
          </div>
          <textarea
            data-action="settings-memory-raw"
            class="min-h-[360px] w-full rounded-[var(--radius-md)] border border-border-weak bg-surface-base p-3 font-mono text-body text-fg-strong"
            value={draft()}
            spellcheck={false}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <div class="flex gap-2">
            <Button variant="primary" onClick={save} disabled={state.loading}>
              {language.t("common.save")}
            </Button>
          </div>
        </section>
      </SettingsList>
    </div>
  )
}
