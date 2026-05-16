import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogDeleteSession(props: {
  name: string
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
    <Dialog title={language.t("session.delete.title")} fit class="w-full max-w-[420px] mx-auto">
      <div class="px-6 pt-2 pb-6">
        <span class="text-body text-fg-strong">
          {language.t("session.delete.confirm", { name: props.name })}
        </span>
      </div>
      <div class="flex justify-end gap-2 px-6 pb-6">
        <Button variant="secondary" onClick={() => dialog.close()} disabled={deleting()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={handleDelete} disabled={deleting()}>
          {language.t("common.delete")}
        </Button>
      </div>
    </Dialog>
  )
}
