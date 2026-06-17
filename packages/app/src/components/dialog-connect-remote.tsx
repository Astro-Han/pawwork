import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { Match, onCleanup, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import type { RemotePairingResult } from "@/desktop-api-contract"
import { useLanguage } from "@/context/language"

// Connect flow for the mobile companion. Reuses the connect-provider dialog
// SHAPE — a small state machine inside a Dialog — but its own backend (the
// main-process bridge over window.api.remote), since this connects a chat bot,
// not an LLM provider. Pairing is paste-token → message-the-bot → approve.
export function DialogConnectRemote(props: { onApproved?: () => void }) {
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
  // Monotonic pairing-attempt id: cancelling (or restarting) pairing bumps it, so
  // a startPairing() that resolves just after the user cancels is ignored instead
  // of flipping the dialog back to the confirm step.
  let attempt = 0
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
    const mine = ++attempt
    setStore({ step: "waiting", error: undefined })
    try {
      const captured = await api.startPairing(token)
      if (!alive.value || mine !== attempt) return
      // null = cancelled before a sender arrived; fall back to the token step.
      if (!captured) return setStore({ step: "token" })
      setStore({ step: "confirm", captured })
    } catch (err) {
      if (!alive.value || mine !== attempt) return
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
      // The bridge is starting but not yet serving. Hand the success signal to the
      // page, which fires the toast only when status actually reaches "connected"
      // (and never when a 409 ends in "degraded") — so we don't claim "connected"
      // here, a step before it is true. Page-side, so it survives this close().
      props.onApproved?.()
      if (!alive.value) return
      dialog.close()
    } catch (err) {
      if (!alive.value) return
      setStore({ busy: false, step: "token", error: errorMessage(err) })
    }
  }

  function backToToken() {
    attempt++ // invalidate any in-flight startPairing so its late resolve is dropped
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
                type="password"
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
