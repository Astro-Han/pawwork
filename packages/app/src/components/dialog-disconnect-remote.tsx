import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

// Irreversible confirm: disconnecting wipes the saved token, so it gets a
// two-button Dialog with a danger action, per the design system. Kept in its own
// module so the disconnect path lazy-loads only this — opening it must not pull in
// the connect flow's pairing state machine (token input, capture poll, toast).
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
