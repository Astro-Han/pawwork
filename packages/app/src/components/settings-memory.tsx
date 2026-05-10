import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { createResource, createSignal, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"

type MemoryState = {
  path?: string
  disabled?: boolean
  status?: "ok" | "safe_mode"
  reason?: string
  content?: string
  profileTooLarge?: boolean
}

export function SettingsMemory(props: { directory?: string }) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const client = () => globalSDK.createClient({ directory: props.directory, throwOnError: true })
  const [draft, setDraft] = createSignal("")
  const [state, actions] = createResource(async () => {
    const result = await client().memory.get()
    const data = (result.data ?? {}) as MemoryState
    setDraft(data.content ?? "")
    return data
  })

  const refresh = () => void actions.refetch()

  const save = async () => {
    await client().memory.update({ memoryRawInput: { content: draft() } })
    showToast({ variant: "success", title: language.t("settings.memory.saved") })
    refresh()
  }

  const reset = async () => {
    if (!window.confirm(language.t("settings.memory.resetConfirm"))) return
    await client().memory.reset()
    showToast({ variant: "success", title: language.t("settings.memory.resetDone") })
    refresh()
  }

  const toggle = async (enabled: boolean) => {
    await client().memory.disabled({ memoryDisabledInput: { disabled: !enabled } })
    refresh()
  }

  return (
    <div class="py-4">
      <SettingsList>
        <section class="flex flex-col gap-1 border-b border-border-weak py-3">
          <h2 class="text-16-medium text-fg-strong">{language.t("settings.memory.title")}</h2>
          <p class="text-13-regular text-fg-weak">{language.t("settings.memory.description")}</p>
          <Show when={state.latest?.path}>
            <p class="text-12-regular text-fg-weaker">{state.latest?.path}</p>
          </Show>
        </section>

        <section class="flex flex-wrap items-center gap-4 border-b border-border-weak py-3 sm:flex-nowrap">
          <div class="min-w-0 flex-1">
            <div class="text-13-medium text-fg-strong">{language.t("settings.memory.enabled.title")}</div>
            <div class="text-13-regular text-fg-weak">{language.t("settings.memory.enabled.description")}</div>
          </div>
          <Switch checked={!state.latest?.disabled} onChange={toggle} />
        </section>

        <Show when={state.latest?.status === "safe_mode"}>
          <section class="rounded border border-danger/40 bg-danger/5 p-3 text-13-regular text-danger">
            {language.t("settings.memory.safeMode", { reason: state.latest?.reason ?? "" })}
          </section>
        </Show>

        <Show when={state.latest?.profileTooLarge}>
          <section class="rounded border border-border bg-bg-panel p-3 text-13-regular text-fg-weak">
            {language.t("settings.memory.profileTooLarge")}
          </section>
        </Show>

        <section class="flex flex-col gap-3 py-3">
          <div>
            <div class="text-13-medium text-fg-strong">{language.t("settings.memory.raw.title")}</div>
            <div class="text-13-regular text-fg-weak">{language.t("settings.memory.raw.description")}</div>
          </div>
          <textarea
            data-action="settings-memory-raw"
            class="min-h-[360px] w-full rounded border border-border bg-bg-panel p-3 font-mono text-13-regular text-fg-strong"
            value={draft()}
            spellcheck={false}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <div class="flex gap-2">
            <Button variant="primary" onClick={save} disabled={state.loading}>
              {language.t("common.save")}
            </Button>
            <Button onClick={reset} disabled={state.loading}>
              {language.t("settings.memory.reset")}
            </Button>
          </div>
        </section>
      </SettingsList>
    </div>
  )
}
