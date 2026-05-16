import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"

export interface ServerFormProps {
  value: string
  name: string
  username: string
  password: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onNameChange: (value: string) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
}

export function ServerForm(props: ServerFormProps) {
  const language = useLanguage()
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      props.onBack()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    props.onSubmit()
  }

  return (
    <div class="px-5">
      <div class="bg-surface-base rounded-md p-5 flex flex-col gap-3">
        <div class="flex-1 min-w-0 [&_[data-slot=input-wrapper]]:relative">
          <TextField
            type="text"
            label={language.t("dialog.server.add.url")}
            placeholder={props.placeholder}
            value={props.value}
            autofocus
            validationState={props.error ? "invalid" : "valid"}
            error={props.error}
            disabled={props.busy}
            onChange={props.onChange}
            onKeyDown={keyDown}
          />
        </div>
        <TextField
          type="text"
          label={language.t("dialog.server.add.name")}
          placeholder={language.t("dialog.server.add.namePlaceholder")}
          value={props.name}
          disabled={props.busy}
          onChange={props.onNameChange}
          onKeyDown={keyDown}
        />
        <div class="grid grid-cols-2 gap-2 min-w-0">
          <TextField
            type="text"
            label={language.t("dialog.server.add.username")}
            placeholder={language.t("dialog.server.add.usernamePlaceholder")}
            value={props.username}
            disabled={props.busy}
            onChange={props.onUsernameChange}
            onKeyDown={keyDown}
          />
          <TextField
            type="password"
            label={language.t("dialog.server.add.password")}
            placeholder={language.t("dialog.server.add.passwordPlaceholder")}
            value={props.password}
            disabled={props.busy}
            onChange={props.onPasswordChange}
            onKeyDown={keyDown}
          />
        </div>
      </div>
    </div>
  )
}
