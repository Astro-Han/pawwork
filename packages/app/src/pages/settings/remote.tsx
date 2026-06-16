import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { type Component, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { SettingsList } from "@/components/settings-list"
import { useLanguage } from "@/context/language"
import type { RemoteState, RemoteStatus } from "@/desktop-api-contract"

const DISCONNECTED: RemoteStatus = { state: "disconnected", platform: null, identity: null, error: null }

// Remote access (mobile companion): connect a phone chat app to this desktop's
// agent. The bridge lives in the main process; this page only shows masked
// status and opens the connect / disconnect dialogs. Layout follows the
// established Settings shape (SettingsList → h2 + description → h3 section).
export const RemotePage: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const [status, setStatus] = createSignal<RemoteStatus>(DISCONNECTED)

  onMount(() => {
    const api = window.api?.remote
    if (!api) return
    void api.getStatus().then(setStatus)
    onCleanup(api.onStatus(setStatus))
  })

  const openConnect = () => {
    void import("@/components/dialog-connect-remote").then((m) => dialog.show(() => <m.DialogConnectRemote />))
  }
  const openDisconnect = () => {
    void import("@/components/dialog-connect-remote").then((m) => dialog.show(() => <m.DialogDisconnectRemote />))
  }

  const statusLabel = () => {
    switch (status().state) {
      case "connected":
        return language.t("settings.remote.status.connected")
      case "connecting":
        return language.t("settings.remote.status.connecting")
      case "degraded":
        return language.t("settings.remote.status.degraded")
      default:
        return language.t("settings.remote.status.disconnected")
    }
  }

  const detail = () => {
    const current = status()
    if (current.state === "degraded") return current.error ?? undefined
    if (current.identity) return language.t("settings.remote.pairedWith", { name: current.identity.userName })
    return undefined
  }

  const connectable = () => status().state === "disconnected"

  return (
    <SettingsList>
      <div class="flex flex-col gap-1 pt-6 pb-2 max-w-[720px]">
        <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.remoteAccess")}</h2>
        <p class="text-body text-fg-weak">{language.t("settings.remote.description")}</p>
      </div>

      <div class="pt-6 pb-2">
        <h3 class="text-h3 text-fg-strong">{language.t("settings.remote.section.telegram")}</h3>
      </div>
      <div class="flex items-center gap-3 py-2.5 border-b border-border-weak max-w-[720px]">
        <StatusIcon state={status().state} />
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-body text-fg-base">{statusLabel()}</span>
          <Show when={detail()}>
            <span class="text-small text-fg-weak truncate">{detail()}</span>
          </Show>
        </div>
        <Switch>
          <Match when={connectable()}>
            <Button variant="secondary" size="small" onClick={openConnect}>
              {language.t("settings.remote.action.connect")}
            </Button>
          </Match>
          <Match when={status().state === "connecting"}>
            <Button variant="secondary" size="small" disabled>
              {language.t("settings.remote.action.connect")}
            </Button>
          </Match>
          <Match when={true}>
            <Button variant="secondary" size="small" onClick={openDisconnect}>
              {language.t("settings.remote.action.disconnect")}
            </Button>
          </Match>
        </Switch>
      </div>

      <div class="pb-10" />
    </SettingsList>
  )
}

function StatusIcon(props: { state: RemoteState }) {
  return (
    <Switch fallback={<Icon name="circle" class="text-fg-weaker shrink-0" />}>
      <Match when={props.state === "connecting"}>
        <Spinner />
      </Match>
      <Match when={props.state === "connected"}>
        <Icon name="circle-check" class="text-icon-success-base shrink-0" />
      </Match>
      <Match when={props.state === "degraded"}>
        <Icon name="circle-ban-sign" class="text-error shrink-0" />
      </Match>
    </Switch>
  )
}
