import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { type ComponentProps, For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { RemoteChannelStatus, RemotePlatform, RemoteState, RemoteStatus } from "@/desktop-api-contract"
import { connectToastAction } from "./connect-toast"
import { PlatformMark, platformNameKey } from "./platform-marks"

type IconName = ComponentProps<typeof Icon>["name"]

// The order channels render in. New platforms append here as their adapters land.
const PLATFORMS: RemotePlatform[] = ["telegram"]

// Remote control: a top-level surface (peer of Automations) to connect a phone
// chat app to this desktop's agent. The bridge lives in the main process; this
// page shows masked per-channel status, what a connection enables, and opens the
// connect / disconnect flows. Each channel row carries a 2px status left-rule (no
// box) per the cards rule in docs/DESIGN.md — green connected, red degraded,
// neutral otherwise.
export function RemoteSurface(props: { onClose: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  // The bridge lives in the main process; without its preload API (web preview,
  // or a preload regression) there is nothing to drive, so the page renders a
  // disabled state instead of Connect buttons that would silently no-op.
  const supported = !!window.api?.remote
  const [channels, setChannels] = createStore<Record<RemotePlatform, RemoteChannelStatus | undefined>>({
    telegram: undefined,
  })
  // Platforms whose connect was just approved; the success toast fires only when
  // each then actually reaches "connected" (never the moment Allow returns), so a
  // bridge that ends "degraded" shows no false success — the row carries the cause.
  const [awaiting, setAwaiting] = createSignal<Set<RemotePlatform>>(new Set())

  const applyStatus = (status: RemoteStatus) => {
    const byPlatform: Partial<Record<RemotePlatform, RemoteChannelStatus>> = {}
    for (const channel of status.channels) byPlatform[channel.platform] = channel

    const stillAwaiting = new Set(awaiting())
    for (const platform of [...stillAwaiting]) {
      const action = connectToastAction(true, byPlatform[platform]?.state ?? "disconnected")
      if (action !== "none") stillAwaiting.delete(platform)
      if (action === "fire") {
        const name = language.t(platformNameKey(platform))
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("remote.connect.toast.title", { platform: name }),
          description: language.t("remote.connect.toast.body", { platform: name }),
        })
      }
    }
    setAwaiting(stillAwaiting)
    setChannels({ telegram: byPlatform.telegram })
  }

  onMount(() => {
    const api = window.api?.remote
    if (api) {
      void api.getStatus().then(applyStatus)
      onCleanup(api.onStatus(applyStatus))
    }
    // Escape closes the surface (the sidebar stays live), unless a dialog is open.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (document.querySelector('[data-component="dialog-overlay"], [data-component="select-content"]')) return
      event.preventDefault()
      props.onClose()
    }
    document.addEventListener("keydown", onEscape, true)
    onCleanup(() => document.removeEventListener("keydown", onEscape, true))
  })

  const openConnect = (platform: RemotePlatform) => {
    void import("./remote-connect-dialog").then((module) =>
      dialog.show(() => (
        <module.DialogConnectRemote
          platform={platform}
          onApproved={(approved) => setAwaiting((prev) => new Set(prev).add(approved))}
        />
      )),
    )
  }
  const openDisconnect = (platform: RemotePlatform) => {
    dialog.show(() => <DialogDisconnectRemote platform={platform} />)
  }

  return (
    <section
      data-component="remote-page"
      aria-label={language.t("remote.title")}
      class="no-scrollbar size-full overflow-y-auto bg-bg-base"
    >
      <div class="mx-auto w-full max-w-[760px] px-6 py-6">
        <div class="flex flex-col gap-1">
          <h2 class="text-h2 text-fg-strong">{language.t("remote.title")}</h2>
          <p class="text-body text-fg-weak">{language.t("remote.description")}</p>
        </div>

        <h3 class="mt-7 mb-1 text-small font-emphasis text-fg-weak">{language.t("remote.channels.title")}</h3>
        <div class="flex flex-col">
          <For each={PLATFORMS}>
            {(platform) => (
              <ChannelRow
                platform={platform}
                status={() => channels[platform]}
                supported={supported}
                onConnect={() => openConnect(platform)}
                onDisconnect={() => openDisconnect(platform)}
              />
            )}
          </For>
        </div>

        <Show when={!supported}>
          <p class="mt-3 text-small text-fg-weak">{language.t("remote.unsupported")}</p>
        </Show>

        <h3 class="mt-8 mb-1 text-h3 text-fg-strong">{language.t("remote.capabilities.title")}</h3>
        <Capability icon="prompt" text={language.t("remote.capabilities.prompts")} />
        <Capability icon="lock" text={language.t("remote.capabilities.permissions")} />
        <Capability icon="new-session" text={language.t("remote.capabilities.sessions")} />
        <div class="pb-10" />
      </div>
    </section>
  )
}

function ChannelRow(props: {
  platform: RemotePlatform
  status: () => RemoteChannelStatus | undefined
  supported: boolean
  onConnect: () => void
  onDisconnect: () => void
}) {
  const language = useLanguage()
  const state = (): RemoteState => props.status()?.state ?? "disconnected"
  // The 2px left-rule and the status word share one color: success connected,
  // error degraded, neutral otherwise. Mirrors the Integrations status mapping.
  const live = () => props.supported && state() === "connected"
  const bad = () => props.supported && state() === "degraded"
  const ruleClass = () => (live() ? "bg-icon-success-base" : bad() ? "bg-error" : "bg-border-weak")
  const labelClass = () => (live() ? "text-icon-success-base" : bad() ? "text-error" : "text-fg-weak")

  const statusLabel = () => {
    if (!props.supported) return language.t("remote.status.disconnected")
    switch (state()) {
      case "connected":
        return language.t("remote.status.connected")
      case "connecting":
        return language.t("remote.status.connecting")
      case "degraded":
        return language.t("remote.status.degraded")
      case "disconnected":
        return language.t("remote.status.disconnected")
    }
  }

  const detail = () => {
    const current = props.status()
    if (!current) return undefined
    if (current.state === "degraded") return current.error ?? undefined
    if (current.identity) return language.t("remote.pairedWith", { name: current.identity.name })
    return undefined
  }

  return (
    <div class="relative flex items-center gap-3 border-t border-border-weak py-3 pl-4 first:border-t-0">
      <div class={`absolute left-0 inset-y-1.5 w-0.5 rounded-full ${ruleClass()}`} aria-hidden="true" />
      <PlatformMark platform={props.platform} />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="text-body text-fg-strong">{language.t(platformNameKey(props.platform))}</span>
        <span class="text-small">
          <span class={labelClass()}>{statusLabel()}</span>
          <Show when={detail()}>
            <span class="ml-3 text-fg-weak">{detail()}</span>
          </Show>
        </span>
      </div>
      <Switch>
        <Match when={!props.supported}>
          <Button variant="secondary" size="small" disabled>
            {language.t("remote.action.connect")}
          </Button>
        </Match>
        <Match when={state() === "disconnected"}>
          <Button variant="primary" size="small" data-action={`remote-connect-${props.platform}`} onClick={props.onConnect}>
            {language.t("remote.action.connect")}
          </Button>
        </Match>
        <Match when={state() === "connecting"}>
          <Button variant="secondary" size="small" disabled>
            {language.t("remote.status.connecting")}
          </Button>
        </Match>
        <Match when={true}>
          <Button
            variant="secondary"
            size="small"
            data-action={`remote-disconnect-${props.platform}`}
            onClick={props.onDisconnect}
          >
            {language.t("remote.action.disconnect")}
          </Button>
        </Match>
      </Switch>
    </div>
  )
}

function Capability(props: { icon: IconName; text: string }) {
  return (
    <div class="flex items-center gap-2.5 py-1.5">
      <Icon name={props.icon} class="size-4 text-fg-weak shrink-0" />
      <span class="text-body text-fg-base">{props.text}</span>
    </div>
  )
}

// Irreversible confirm: disconnecting wipes the saved credential, so it gets a
// two-button Dialog with a danger action. Inlined (not a lazy module): a trivial
// confirm whose deps already ship with this page.
function DialogDisconnectRemote(props: { platform: RemotePlatform }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const name = language.t(platformNameKey(props.platform))

  const handleDisconnect = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await window.api?.remote?.disconnect(props.platform)
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={language.t("remote.disconnect.title", { platform: name })} fit class="w-full max-w-[420px] mx-auto">
      <div class="px-6 pt-2 pb-6">
        <span class="text-body text-fg-strong">{language.t("remote.disconnect.body")}</span>
      </div>
      <div class="flex justify-end gap-2 px-6 pb-6">
        <Button variant="secondary" onClick={() => dialog.close()} disabled={busy()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={handleDisconnect} disabled={busy()}>
          {language.t("remote.action.disconnect")}
        </Button>
      </div>
    </Dialog>
  )
}
