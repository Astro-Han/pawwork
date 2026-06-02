import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogDeleteAutomation(props: {
  title: string
  onConfirm: () => Promise<void> | void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [deleting, setDeleting] = createSignal(false)

  const handleDelete = async () => {
    if (deleting()) return
    setDeleting(true)
    try {
      await props.onConfirm()
      dialog.close()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog title={language.t("automations.delete.title")} fit class="w-full max-w-[420px] mx-auto">
      <div class="px-6 pt-2 pb-6">
        <span class="text-body text-fg-strong">{language.t("automations.delete.confirm", { title: props.title })}</span>
        <p class="mt-2 text-body text-fg-weak">{language.t("automations.delete.description")}</p>
      </div>
      <div class="flex justify-end gap-2 px-6 pb-6">
        <Button variant="secondary" onClick={() => dialog.close()} disabled={deleting()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={handleDelete} disabled={deleting()}>
          {language.t("automations.action.delete")}
        </Button>
      </div>
    </Dialog>
  )
}
