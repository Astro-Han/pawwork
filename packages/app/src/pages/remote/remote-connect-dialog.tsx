import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { RemotePairingEvent, RemotePlatform } from "@/desktop-api-contract"
import { PlatformMark } from "./platform-marks"

// The connect flow, driven by the main-process pairing event stream
// (window.api.remote.onPairing). Telegram opens on a token field, then runs
// token → checking → bind → confirm as the backend reports them. WeChat has nothing
// to type, so it opens straight on the QR: starting → qr → (scan + confirm in WeChat
// authorizes it, so the captured identity is approved automatically). Built around
// the generic event shape so platforms slot in. The secret never comes back: confirm
// approves the captured identity, the Telegram token crossed once on startPairing,
// the WeChat creds were minted main-side.

type Phase = "token" | "checking" | "starting" | "qr" | "bind" | "confirm" | "error"

export function DialogConnectRemote(props: {
  platform: RemotePlatform
  onApproved?: (platform: RemotePlatform) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = props.platform
  // QR platforms (WeChat) have nothing to type — they open straight into the flow.
  const isQr = platform !== "telegram"

  const [store, setStore] = createStore({
    phase: (isQr ? "starting" : "token") as Phase,
    token: "",
    qrImage: undefined as string | undefined,
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
        setStore({ phase: "qr", qrImage: event.image, error: undefined })
        break
      case "awaitingBind":
        setStore({ phase: "bind" })
        break
      case "captured":
        setStore({ captured: event.identity })
        // WeChat's scan + in-app confirm already authorized this connection, so
        // there is no second desktop approval — wire it up automatically. Telegram
        // shows the confirm step so the user vets the captured sender first.
        if (isQr) {
          setStore({ phase: "starting" })
          void allow()
        } else {
          setStore({ phase: "confirm" })
        }
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
    if (isQr) void api.startPairing(platform)
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
    // Show "checking" and let the event stream advance us: startPairing validates
    // the token first and only then emits awaitingBind (→ bind) or error. Jumping
    // straight to bind here would tell the user to message the bot before the token
    // is even known to be good.
    setStore({ phase: "checking", error: undefined })
    void api.startPairing(platform, { token })
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
    setStore({ error: undefined, captured: undefined, qrImage: undefined })
    if (!isQr) {
      setStore("phase", "token")
      return
    }
    // startPairing supersedes any prior attempt main-side, so a fresh call is enough.
    setStore("phase", "starting")
    void api?.startPairing(platform)
  }

  const title = () =>
    language.t(platform === "wechat" ? "remote.connect.wechat.title" : "remote.connect.telegram.title")

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

          <Match when={store.phase === "checking"}>
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Spinner />
                <span>{language.t("remote.connect.checking.title")}</span>
              </div>
              <div class="flex justify-end">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={store.phase === "starting"}>
            <div class="flex items-center gap-2 text-body text-fg-strong">
              <Spinner />
              <span>{language.t("remote.connect.starting")}</span>
            </div>
          </Match>

          <Match when={store.phase === "qr"}>
            <div class="flex flex-col gap-3">
              <span class="text-body text-fg-strong">{language.t("remote.connect.qr.wechat.title")}</span>
              <p class="text-small text-fg-weak">{language.t("remote.connect.qr.wechat.body")}</p>
              <Show when={store.qrImage}>
                <img
                  src={store.qrImage}
                  alt=""
                  class="size-[200px] self-center rounded-md border border-border-weak bg-white p-1"
                />
              </Show>
              <div class="flex justify-end">
                <Button variant="secondary" onClick={() => dialog.close()}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={store.phase === "bind"}>
            <div class="flex flex-col gap-4">
              <div class="flex justify-center pt-1">
                <ListeningPulse platform={platform} />
              </div>
              <div class="flex flex-col items-center gap-1.5 text-center">
                <span class="text-body font-emphasis text-fg-strong">
                  {language.t("remote.connect.bind.message.title")}
                </span>
                <p class="text-body text-fg-weak">{language.t("remote.connect.bind.message.body")}</p>
                <p class="text-small text-fg-weak">{language.t("remote.connect.bind.message.note")}</p>
              </div>
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

// While the bridge long-polls for the user's first message, concentric rings
// ripple out from the platform mark — a calm "we're listening" cue. The brand
// blue is the sanctioned vendor-color exception (see platform-marks); when a
// second platform lands, the accent moves there alongside the mark. With motion
// suppressed the rings rest as a single static ring around the mark.
function ListeningPulse(props: { platform: RemotePlatform }) {
  return (
    <div class="relative grid size-24 place-items-center" aria-hidden="true">
      <For each={[0, 0.8, 1.6]}>
        {(delay) => (
          <span
            class="absolute inset-0 rounded-full border-2 border-[#229ED9]"
            style={{ animation: "var(--animate-radar)", "animation-delay": `${delay}s` }}
          />
        )}
      </For>
      <span class="relative grid size-[52px] place-items-center rounded-full bg-[#229ED9]/12">
        <PlatformMark platform={props.platform} />
      </span>
    </div>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
