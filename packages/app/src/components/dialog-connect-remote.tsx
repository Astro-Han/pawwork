import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, Match, onCleanup, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import type { RemotePairingResult } from "@/desktop-api-contract"
import { useLanguage } from "@/context/language"

// Connect flow for the mobile companion. Reuses the connect-provider dialog
// SHAPE — a small state machine inside a Dialog — but its own backend (the
// main-process bridge over window.api.remote), since this connects a chat bot,
// not an LLM provider. Pairing is paste-token → message-the-bot → approve.
export function DialogConnectRemote() {
  const language = useLanguage()
  const dialog = useDialog()

  const [store, setStore] = createStore({
    step: "token" as "token" | "waiting" | "confirm",
    token: "",
    captured: undefined as RemotePairingResult | undefined,
    error: undefined as string | undefined,
    busy: false,
  })

  // Guard against late async resolutions after the dialog is gone, and stop the
  // bot's capture poll when the dialog closes mid-pairing.
  const alive = { value: true }
  onCleanup(() => {
    alive.value = false
    void window.api?.remote?.cancelPairing()
  })

  const remote = () => window.api?.remote

  async function startPairing(event?: Event) {
    event?.preventDefault()
    const api = remote()
    const token = store.token.trim()
    if (!api || token === "" || store.busy) return
    setStore({ step: "waiting", error: undefined })
    try {
      const captured = await api.startPairing(token)
      if (!alive.value) return
      // null = cancelled before a sender arrived; fall back to the token step.
      if (!captured) return setStore({ step: "token" })
      setStore({ step: "confirm", captured })
    } catch (err) {
      if (!alive.value) return
      setStore({ step: "token", error: errorMessage(err) })
    }
  }

  async function allow() {
    const api = remote()
    const captured = store.captured
    if (!api || !captured || store.busy) return
    setStore("busy", true)
    try {
      // The main process holds the token + captured identity from startPairing;
      // confirm just approves it — we never resend the secret.
      await api.confirmPairing()
      if (!alive.value) return
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.remote.connect.toast.title"),
        description: language.t("settings.remote.connect.toast.body"),
      })
    } catch (err) {
      if (!alive.value) return
      setStore({ busy: false, step: "token", error: errorMessage(err) })
    }
  }

  function backToToken() {
    void remote()?.cancelPairing()
    setStore({ step: "token", captured: undefined })
  }

  return (
    <Dialog title={language.t("settings.remote.connect.title")} fit class="w-full max-w-[460px] mx-auto">
      <div class="px-6 pt-2 pb-6 flex flex-col gap-5">
        <Switch>
          <Match when={store.step === "token"}>
            <form onSubmit={startPairing} class="flex flex-col gap-4">
              <TextField
                autofocus
                type="text"
                label={language.t("settings.remote.connect.token.label")}
                placeholder={language.t("settings.remote.connect.token.placeholder")}
                name="token"
                value={store.token}
                onChange={(value) => setStore("token", value)}
                validationState={store.error ? "invalid" : undefined}
                error={store.error}
              />
              <p class="text-small text-fg-weak">{language.t("settings.remote.connect.token.help")}</p>
              <div class="flex justify-end">
                <Button type="submit" variant="primary" disabled={store.token.trim() === ""}>
                  {language.t("common.continue")}
                </Button>
              </div>
            </form>
          </Match>

          <Match when={store.step === "waiting"}>
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Spinner />
                <span>{language.t("settings.remote.connect.waiting.title")}</span>
              </div>
              <p class="text-body text-fg-weak">{language.t("settings.remote.connect.waiting.body")}</p>
              <div class="flex justify-end">
                <Button variant="secondary" onClick={backToToken}>
                  {language.t("common.cancel")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={store.step === "confirm"}>
            <div class="flex flex-col gap-4">
              <div class="flex items-center gap-2 text-body text-fg-strong">
                <Icon name="circle-check" class="text-icon-success-base" />
                <span>{language.t("settings.remote.connect.confirm.title")}</span>
              </div>
              <p class="text-body text-fg-weak">
                {language.t("settings.remote.connect.confirm.body", { name: store.captured?.userName ?? "" })}
              </p>
              <div class="flex justify-end gap-2">
                <Button variant="secondary" onClick={backToToken} disabled={store.busy}>
                  {language.t("common.cancel")}
                </Button>
                <Button variant="primary" onClick={allow} disabled={store.busy}>
                  {language.t("settings.remote.connect.action.allow")}
                </Button>
              </div>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}

// Irreversible confirm: disconnecting wipes the saved token, so it gets a
// two-button Dialog with a danger action, per the design system.
export function DialogDisconnectRemote() {
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const handleDisconnect = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await window.api?.remote?.disconnect()
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={language.t("settings.remote.disconnect.title")} fit class="w-full max-w-[420px] mx-auto">
      <div class="px-6 pt-2 pb-6">
        <span class="text-body text-fg-strong">{language.t("settings.remote.disconnect.body")}</span>
      </div>
      <div class="flex justify-end gap-2 px-6 pb-6">
        <Button variant="secondary" onClick={() => dialog.close()} disabled={busy()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={handleDisconnect} disabled={busy()}>
          {language.t("settings.remote.action.disconnect")}
        </Button>
      </div>
    </Dialog>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
