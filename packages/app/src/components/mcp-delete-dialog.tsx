import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function McpDeleteDialog(props: { name: string; onDelete: () => Promise<unknown> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [pending, setPending] = createSignal(false)

  const confirm = async () => {
    setPending(true)
    try {
      await props.onDelete()
      dialog.close()
    } catch {
      setPending(false)
    }
  }

  return (
    <Dialog title={language.t("settings.mcp.delete.title", { name: props.name })}>
      <div class="flex flex-col gap-5 px-5 pb-5">
        <p class="text-body text-fg-weak">{language.t("settings.mcp.delete.confirm")}</p>
        <div class="flex justify-end gap-2">
          <Button variant="secondary" disabled={pending()} onClick={() => dialog.close()}>
            {language.t("settings.mcp.delete.keep")}
          </Button>
          <Button variant="danger" disabled={pending()} onClick={confirm}>
            {language.t("settings.mcp.delete.action")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
