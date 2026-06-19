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

// The connect flow, driven by the main-process pairing event stream
// (window.api.remote.onPairing). Telegram opens on a token field, then the phases
// run token → bind → confirm as the backend reports them. The secret never comes
// back: confirm approves the captured identity, and the token crossed once on
// startPairing. Built around the generic event shape so new platforms slot in.

type Phase = "token" | "bind" | "confirm" | "error"

export function DialogConnectRemote(props: {
  platform: RemotePlatform
  onApproved?: (platform: RemotePlatform) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = props.platform

  const [store, setStore] = createStore({
    phase: "token" as Phase,
    token: "",
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
      case "awaitingBind":
        setStore({ phase: "bind" })
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
    // us to confirm. startPairing emits awaitingBind then captured.
    setStore({ phase: "bind", error: undefined })
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
    setStore({ error: undefined, captured: undefined, phase: "token" })
  }

  return (
    <Dialog title={language.t("remote.connect.telegram.title")} fit class="w-full max-w-[460px] mx-auto">
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

          <Match when={store.phase === "bind"}>
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Spinner />
                <span>{language.t("remote.connect.bind.message.title")}</span>
              </div>
              <p class="text-body text-fg-weak">{language.t("remote.connect.bind.message.body")}</p>
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
