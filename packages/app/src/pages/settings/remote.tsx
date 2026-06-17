import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { type Component, type ComponentProps, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { SettingsList } from "@/components/settings-list"
import { useLanguage } from "@/context/language"
import type { RemoteStatus } from "@/desktop-api-contract"
import { connectToastAction } from "./remote-connect-toast"

const DISCONNECTED: RemoteStatus = { state: "disconnected", platform: null, identity: null, error: null }

type IconName = ComponentProps<typeof Icon>["name"]

// Remote access (mobile companion): connect a phone chat app to this desktop's
// agent. The bridge lives in the main process; this page shows masked status,
// what the connection enables, and opens the connect / disconnect dialogs. The
// Telegram row carries a 2px status left-rule (no box) per the cards rule in
// docs/DESIGN.md — green when connected, red when degraded, neutral otherwise.
export const RemotePage: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const [status, setStatus] = createSignal<RemoteStatus>(DISCONNECTED)
  // The bridge lives in the main process; without its preload API (web preview,
  // or a preload regression) there is nothing to drive, so the page shows a
  // disabled "needs the desktop app" state instead of a Connect button that
  // would silently no-op.
  const supported = !!window.api?.remote
  // Armed by the connect dialog's Allow; the success toast fires only when status
  // then actually reaches "connected" (see handleStatus), never the moment Allow
  // returns. So a bridge that ends up "degraded" (e.g. a 409: another client owns
  // the token) shows no false "connected" toast.
  const [awaitingConnect, setAwaitingConnect] = createSignal(false)

  // Defer the connect success toast to the real "connected" transition (see
  // connectToastAction): a terminal non-connected outcome just disarms — the
  // status row (red "Connection problem" + the cause) already carries the failure.
  const handleStatus = (next: RemoteStatus) => {
    const action = connectToastAction(awaitingConnect(), next.state)
    if (action !== "none") setAwaitingConnect(false)
    if (action === "fire") {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.remote.connect.toast.title"),
        description: language.t("settings.remote.connect.toast.body"),
      })
    }
    setStatus(next)
  }

  onMount(() => {
    const api = window.api?.remote
    if (!api) return
    void api.getStatus().then(setStatus)
    onCleanup(api.onStatus(handleStatus))
  })

  const openConnect = () => {
    setAwaitingConnect(false) // fresh attempt; arm only when Allow is clicked
    void import("@/components/dialog-connect-remote").then((m) =>
      dialog.show(() => <m.DialogConnectRemote onApproved={() => setAwaitingConnect(true)} />),
    )
  }
  const openDisconnect = () => {
    void import("@/components/dialog-disconnect-remote").then((m) => dialog.show(() => <m.DialogDisconnectRemote />))
  }

  const statusLabel = () => {
    if (!supported) return language.t("settings.remote.unsupported")
    switch (status().state) {
      case "connected":
        return language.t("settings.remote.status.connected")
      case "connecting":
        return language.t("settings.remote.status.connecting")
      case "degraded":
        return language.t("settings.remote.status.degraded")
      case "disconnected":
        return language.t("settings.remote.status.disconnected")
    }
  }

  // The 2px left-rule and the status word share one color: success when
  // connected, error when degraded, neutral otherwise (idle / connecting /
  // unsupported). Mirrors the Integrations status mapping.
  const live = () => supported && status().state === "connected"
  const bad = () => supported && status().state === "degraded"
  const ruleClass = () => (live() ? "bg-icon-success-base" : bad() ? "bg-error" : "bg-border-weak")
  const labelClass = () => (live() ? "text-icon-success-base" : bad() ? "text-error" : "text-fg-weak")

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

      <div class="relative mt-4 flex items-center gap-3 py-3 pl-4 max-w-[720px]">
        <div class={`absolute left-0 inset-y-1 w-0.5 rounded-full ${ruleClass()}`} aria-hidden="true" />
        <TelegramMark />
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-body text-fg-strong">{language.t("settings.remote.section.telegram")}</span>
          <span class="text-small">
            <span class={labelClass()}>{statusLabel()}</span>
            <Show when={detail()}>
              <span class="ml-3 text-fg-weak">{detail()}</span>
            </Show>
          </span>
        </div>
        <Switch>
          <Match when={!supported}>
            <Button variant="secondary" size="small" disabled>
              {language.t("settings.remote.action.connect")}
            </Button>
          </Match>
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

      <div class="pt-6 pb-2">
        <h3 class="text-h3 text-fg-strong">{language.t("settings.remote.capabilities.title")}</h3>
      </div>
      <Capability icon="prompt" text={language.t("settings.remote.capabilities.prompts")} />
      <Capability icon="lock" text={language.t("settings.remote.capabilities.permissions")} />
      <Capability icon="new-session" text={language.t("settings.remote.capabilities.sessions")} />

      <div class="pb-10" />
    </SettingsList>
  )
}

// The Telegram vendor mark keeps its brand color — a sanctioned exception to the
// one-icon-DNA chrome rule (docs/DESIGN.md: app/vendor logos keep brand colors).
function TelegramMark() {
  return (
    <svg viewBox="0 0 24 24" class="size-5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#229ED9" />
      <path
        fill="#fff"
        d="M5.6 11.8 16.5 7.6c.5-.2 1 .1.8.8l-1.85 8.74c-.14.62-.5.77-1.02.48l-2.82-2.08-1.36 1.31c-.15.15-.28.28-.57.28l.2-2.86 5.2-4.7c.23-.2-.05-.32-.35-.12l-6.43 4.05-2.77-.86c-.6-.19-.62-.6.13-.9z"
      />
    </svg>
  )
}

function Capability(props: { icon: IconName; text: string }) {
  return (
    <div class="flex items-center gap-2.5 py-1.5 max-w-[720px]">
      <Icon name={props.icon} class="size-4 text-fg-weak shrink-0" />
      <span class="text-body text-fg-base">{props.text}</span>
    </div>
  )
}
