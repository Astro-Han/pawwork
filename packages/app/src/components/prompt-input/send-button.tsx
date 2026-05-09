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
      data-state={props.stopping ? "running" : "idle"}
      type="submit"
      disabled={props.disabled}
      tabIndex={props.tabIndex}
      aria-label={props["aria-label"]}
      onClick={props.onClick}
      style={{
        ...(typeof props.style === "object" ? props.style : {}),
        // Send button affordance is theme-locked: orange send / ink stop look
        // identical in light and dark so the user's muscle memory holds.
        // Theme-aware tokens would mirror across themes (bug: dark idle becomes
        // orange + dark-page-color icon; dark stopping becomes bone-white + dark icon).
        background: props.disabled
          ? "var(--icon-weak)"
          : props.stopping
            ? "#1A1613"
            : "var(--button-brand-base)",
      }}
      class="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed"
    >
      <Icon
        name={props.stopping ? "stop-square" : "arrow-up"}
        class="size-[16px]"
        data-icon={props.stopping ? "stop" : "arrow-up"}
        style={{ color: props.disabled ? "var(--fg-weak)" : "#FFFFFF" }}
      />
    </button>
  )
}
