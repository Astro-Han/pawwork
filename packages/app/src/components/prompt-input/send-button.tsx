import type { Component, JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

export interface SendButtonProps {
  stopping: boolean
  disabled: boolean
  tabIndex?: number
  "aria-label": string
  onClick?: JSX.EventHandler<HTMLButtonElement, MouseEvent>
  style?: JSX.CSSProperties | string
}

export const SendButton: Component<SendButtonProps> = (props) => {
  return (
    <button
      data-action="prompt-submit"
      type="submit"
      disabled={props.disabled}
      tabIndex={props.tabIndex}
      aria-label={props["aria-label"]}
      onClick={props.onClick}
      style={props.style}
      class="inline-flex size-7 items-center justify-center rounded-full bg-button-brand-base shadow-[0_1px_3px_var(--button-brand-shadow)] transition-colors duration-150 hover:bg-button-brand-hover disabled:bg-border-weak-base disabled:cursor-not-allowed disabled:shadow-none"
    >
      <Icon
        name={props.stopping ? "stop-square" : "arrow-up"}
        class="size-3.5"
        data-icon={props.stopping ? "stop" : "arrow-up"}
        style={{ color: props.disabled ? "var(--text-weak)" : "#ffffff" }}
      />
    </button>
  )
}
