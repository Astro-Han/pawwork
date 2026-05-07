import { TextField as Kobalte } from "@kobalte/core/text-field"
import { createSignal, Show, splitProps } from "solid-js"
import type { ComponentProps } from "solid-js"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"

export interface TextFieldProps
  extends ComponentProps<typeof Kobalte.Input>,
    Partial<
      Pick<
        ComponentProps<typeof Kobalte>,
        | "name"
        | "defaultValue"
        | "value"
        | "onChange"
        | "onKeyDown"
        | "validationState"
        | "required"
        | "disabled"
        | "readOnly"
      >
    > {
  label?: string
  hideLabel?: boolean
  description?: string
  /** Error message text. When set, the field enters invalid state and shows an error icon. */
  error?: string
  variant?: "normal" | "ghost" | "inline"
  copyable?: boolean
  copyKind?: "clipboard" | "link"
  multiline?: boolean
  /** Auto-select all text when the input gains focus. Useful for inline rename. */
  selectOnFocus?: boolean
}

export function TextField(props: TextFieldProps) {
  const i18n = useI18n()
  const [local, others] = splitProps(props, [
    "name",
    "defaultValue",
    "value",
    "onChange",
    "onKeyDown",
    "validationState",
    "required",
    "disabled",
    "readOnly",
    "class",
    "label",
    "hideLabel",
    "description",
    "error",
    "variant",
    "copyable",
    "copyKind",
    "multiline",
    "selectOnFocus",
  ])
  const [copied, setCopied] = createSignal(false)

  const label = () => {
    if (copied()) return i18n.t("ui.textField.copied")
    if (local.copyKind === "link") return i18n.t("ui.textField.copyLink")
    return i18n.t("ui.textField.copyToClipboard")
  }

  const icon = () => {
    if (copied()) return "check"
    if (local.copyKind === "link") return "link"
    return "copy"
  }

  async function handleCopy() {
    const value = local.value ?? local.defaultValue ?? ""
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleClick() {
    if (local.copyable) void handleCopy()
  }

  // Derive validationState: explicit prop wins, otherwise error string implies invalid
  const validationState = () => local.validationState ?? (local.error ? "invalid" : undefined)

  return (
    <Kobalte
      data-component="input"
      data-variant={local.variant || "normal"}
      name={local.name}
      defaultValue={local.defaultValue}
      value={local.value}
      onChange={local.onChange}
      onKeyDown={local.onKeyDown}
      onClick={handleClick}
      required={local.required}
      disabled={local.disabled}
      readOnly={local.readOnly}
      validationState={validationState()}
    >
      <Show when={local.label}>
        <Kobalte.Label data-slot="input-label" classList={{ "sr-only": local.hideLabel }}>
          {local.label}
        </Kobalte.Label>
      </Show>
      <div data-slot="input-wrapper">
        <Show
          when={local.multiline}
          fallback={
            <Kobalte.Input
              {...others}
              data-slot="input-input"
              class={local.class}
              onFocus={(event: FocusEvent & { currentTarget: HTMLInputElement }) => {
                if (local.selectOnFocus) event.currentTarget.select()
                ;(others as { onFocus?: (e: FocusEvent) => void }).onFocus?.(event)
              }}
            />
          }
        >
          <Kobalte.TextArea
            {...others}
            autoResize
            data-slot="input-input"
            class={local.class}
            onFocus={(event: FocusEvent & { currentTarget: HTMLTextAreaElement }) => {
              if (local.selectOnFocus) event.currentTarget.select()
              ;(others as { onFocus?: (e: FocusEvent) => void }).onFocus?.(event)
            }}
          />
        </Show>
        <Show when={local.copyable}>
          <Tooltip value={label()} placement="top" gutter={4} forceOpen={copied()} skipDelayDuration={0}>
            <IconButton
              type="button"
              icon={icon()}
              variant="ghost"
              onClick={handleCopy}
              tabIndex={-1}
              data-slot="input-copy-button"
              aria-label={label()}
            />
          </Tooltip>
        </Show>
      </div>
      <Show when={local.description}>
        <Kobalte.Description data-slot="input-description">{local.description}</Kobalte.Description>
      </Show>
      <Kobalte.ErrorMessage data-slot="input-error">
        <Icon name="warning" aria-hidden="true" />
        {local.error}
      </Kobalte.ErrorMessage>
    </Kobalte>
  )
}
