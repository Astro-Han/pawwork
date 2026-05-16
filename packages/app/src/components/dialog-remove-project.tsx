import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogRemoveProject(props: {
  name: string
  onConfirm: () => Promise<void> | void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [removing, setRemoving] = createSignal(false)

  const handleRemove = async () => {
    if (removing()) return
    setRemoving(true)
    try {
      await props.onConfirm()
      dialog.close()
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Dialog title={language.t("project.remove.title")} fit class="w-full max-w-[420px] mx-auto">
      <div class="px-6 pt-2 pb-6">
        <span class="text-body text-fg-strong">
          {language.t("project.remove.confirm", { name: props.name })}
        </span>
        <p class="mt-2 text-body text-fg-weak">
          {language.t("project.remove.description")}
        </p>
      </div>
      <div class="flex justify-end gap-2 px-6 pb-6">
        <Button variant="secondary" onClick={() => dialog.close()} disabled={removing()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={handleRemove} disabled={removing()}>
          {language.t("common.remove")}
        </Button>
      </div>
    </Dialog>
  )
}
