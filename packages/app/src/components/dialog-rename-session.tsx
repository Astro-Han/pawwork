import { createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export function DialogRenameSession(props: {
  name: string
  onConfirm: (name: string) => Promise<void> | void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [value, setValue] = createSignal(props.name)
  const [saving, setSaving] = createSignal(false)

  const handleSave = async () => {
    const next = value().trim()
    if (!next || saving()) return
    setSaving(true)
    try {
      await props.onConfirm(next)
      dialog.close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={language.t("session.rename.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-2">
          <p class="text-13-regular text-fg-base">{language.t("session.rename.hint")}</p>
          <TextField
            label=""
            hideLabel
            value={value()}
            onInput={(e: InputEvent & { currentTarget: HTMLInputElement }) =>
              setValue(e.currentTarget.value)
            }
            onKeyDown={(e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleSave()
              }
              if (e.key === "Escape") {
                e.preventDefault()
                dialog.close()
              }
            }}
          />
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()} disabled={saving()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving() || !value().trim()}
          >
            {language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
