import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { RemotePairingEvent, RemotePlatform } from "@/desktop-api-contract"

// One connect flow for all platforms, driven by the main-process pairing event
// stream (window.api.remote.onPairing). Telegram opens on a token field; Feishu /
// WeChat open straight on the QR. From there the phases are uniform — qr → bind →
// confirm — because the backend normalizes each platform's handshake into the same
// event shape. Secrets never come back: confirm approves the captured identity, the
// token (Telegram) crossed once on startPairing, the QR creds were minted main-side.

type Phase = "token" | "starting" | "qr" | "bind" | "confirm" | "error"

export function DialogConnectRemote(props: {
  platform: RemotePlatform
  onApproved?: (platform: RemotePlatform) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = props.platform

  const [store, setStore] = createStore({
    phase: (platform === "telegram" ? "token" : "starting") as Phase,
    token: "",
    qr: undefined as { image?: string; url?: string; code?: string } | undefined,
    bindHint: "message" as "message" | "group",
    captured: undefined as { id: string; name: string } | undefined,
    error: undefined as string | undefined,
    busy: false,
  })

  // Guard against events / resolutions landing after the dialog is gone.
  const alive = { value: true }
  const remote = () => window.api?.remote

  const handlePairing = (event: RemotePairingEvent) => {
    if (!alive.value || event.platform !== platform) return
    switch (event.phase) {
      case "qr":
        setStore({ phase: "qr", qr: { image: event.image, url: event.url, code: event.code }, error: undefined })
        break
      case "awaitingBind":
        setStore({ phase: "bind", bindHint: event.hint })
        break
      case "captured":
        setStore({ phase: "confirm", captured: event.identity })
        break
      case "error":
        setStore({ phase: "error", error: event.message, busy: false })
        break
      case "cancelled":
        break // a cancel we initiated (close / retry); the UI has already moved on
    }
  }

  onMount(() => {
    const api = remote()
    if (!api) return
    onCleanup(api.onPairing(handlePairing))
    // QR platforms have nothing to type — kick the flow off immediately.
    if (platform !== "telegram") void api.startPairing(platform)
  })
  onCleanup(() => {
    alive.value = false
    void remote()?.cancelPairing()
  })

  function submitToken(event?: Event) {
    event?.preventDefault()
    const api = remote()
    const token = store.token.trim()
    if (!api || token === "" || store.busy) return
    // The bot is messaged next; show the bind step and let the event stream advance
    // us to confirm. startPairing emits awaitingBind(message) then captured.
    setStore({ phase: "bind", bindHint: "message", error: undefined })
    void api.startPairing("telegram", { token })
  }

  async function allow() {
    const api = remote()
    if (!api || !store.captured || store.busy) return
    setStore("busy", true)
    try {
      // The credential + captured identity are held main-side from startPairing;
      // confirm just approves them — we never resend the secret. The success toast
      // fires page-side when status actually reaches "connected", not here.
      await api.confirmPairing(platform)
      props.onApproved?.(platform)
      if (alive.value) dialog.close()
    } catch (err) {
      if (alive.value) setStore({ busy: false, phase: "error", error: errorMessage(err) })
    }
  }

  function retry() {
    const api = remote()
    setStore({ error: undefined, captured: undefined, qr: undefined })
    if (platform === "telegram") {
      setStore("phase", "token")
      return
    }
    // startPairing supersedes any prior attempt main-side, so a fresh call is enough.
    setStore("phase", "starting")
    void api?.startPairing(platform)
  }

  const title = () =>
    language.t(
      platform === "telegram"
        ? "remote.connect.telegram.title"
        : platform === "feishu"
          ? "remote.connect.feishu.title"
          : "remote.connect.wechat.title",
    )

  return (
    <Dialog title={title()} fit class="w-full max-w-[460px] mx-auto">
      <div class="px-6 pt-2 pb-6 flex flex-col gap-5">
        <Switch>
          <Match when={store.phase === "token"}>
            <form onSubmit={submitToken} class="flex flex-col gap-4">
              <TextField
                autofocus
                type="password"
                label={language.t("remote.connect.token.label")}
                placeholder={language.t("remote.connect.token.placeholder")}
                name="token"
                value={store.token}
                onChange={(value) => setStore("token", value)}
              />
              <p class="text-small text-fg-weak">{language.t("remote.connect.token.help")}</p>
              <div class="flex justify-end">
                <Button type="submit" variant="primary" disabled={store.token.trim() === ""}>
                  {language.t("common.continue")}
                </Button>
              </div>
            </form>
          </Match>

          <Match when={store.phase === "starting"}>
            <div class="flex items-center gap-2 text-body text-fg-strong">
              <Spinner />
              <span>{language.t("remote.connect.starting")}</span>
            </div>
          </Match>

          <Match when={store.phase === "qr"}>
            <div class="flex flex-col gap-3">
              <span class="text-body text-fg-strong">
                {language.t(platform === "feishu" ? "remote.connect.qr.feishu.title" : "remote.connect.qr.wechat.title")}
              </span>
              <p class="text-small text-fg-weak">
                {language.t(platform === "feishu" ? "remote.connect.qr.feishu.body" : "remote.connect.qr.wechat.body")}
              </p>
              <Show
                when={store.qr?.image}
                fallback={<QrFallback url={store.qr?.url} />}
              >
                <img
                  src={store.qr?.image}
                  alt=""
                  class="size-[200px] self-center rounded-md border border-border-weak bg-white p-1"
                />
              </Show>
              <Show when={store.qr?.code}>
                <div class="self-center font-mono text-small tracking-widest text-fg-strong">{store.qr?.code}</div>
              </Show>
              <div class="flex justify-end">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={store.phase === "bind"}>
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Spinner />
                <span>
                  {language.t(
                    store.bindHint === "group" ? "remote.connect.bind.group.title" : "remote.connect.bind.message.title",
                  )}
                </span>
              </div>
              <p class="text-body text-fg-weak">
                {language.t(
                  store.bindHint === "group" ? "remote.connect.bind.group.body" : "remote.connect.bind.message.body",
                )}
              </p>
              <div class="flex justify-end">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={store.phase === "confirm"}>
            <div class="flex flex-col gap-4">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Icon name="circle-check" class="text-icon-success-base" />
                <span>{language.t("remote.connect.confirm.title")}</span>
              </div>
              <p class="text-body text-fg-weak">
                {language.t("remote.connect.confirm.body", { name: store.captured?.name ?? "" })}
              </p>
              <div class="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => dialog.close()} disabled={store.busy}>
                  {language.t("common.cancel")}
                </Button>
                <Button variant="primary" onClick={allow} disabled={store.busy}>
                  {language.t("remote.connect.action.allow")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={store.phase === "error"}>
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Icon name="warning" class="text-error" />
                <span>{language.t("remote.connect.error.title")}</span>
              </div>
              <Show when={store.error}>
                <p class="text-small text-fg-weak">{store.error}</p>
              </Show>
              <div class="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
                <Button variant="primary" onClick={retry}>
                  {language.t("remote.connect.action.retry")}
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}

// Shown only if main-side QR rendering failed: the launcher link the user can open
// on their phone instead of scanning.
function QrFallback(props: { url?: string }) {
  const language = useLanguage()
  return (
    <Show when={props.url}>
      <div class="flex flex-col items-center gap-2 text-center">
        <p class="text-small text-fg-weak">{language.t("remote.connect.qr.fallback")}</p>
        <a href={props.url} target="_blank" rel="noreferrer" class="text-small text-fg-base underline break-all">
          {props.url}
        </a>
      </div>
    </Show>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
