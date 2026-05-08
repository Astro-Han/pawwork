// Composer bottom-bar model control with inline thinking-level indicator.
// Variant selection moved into the model picker popover (see model-picker.tsx);
// this control is the trigger for the combined picker.

import { Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import type { useCommand } from "@/context/command"
import type { useLanguage } from "@/context/language"
import type { useLocal } from "@/context/local"
import { ModelSelectorPopover } from "./model-picker"
import { translateVariant } from "./variant-label"

type TriggerStyle = () => Record<string, string | number | undefined>

export function PromptModelControl(props: {
  triggerStyle: TriggerStyle
  actionReady: () => boolean
  model: ReturnType<typeof useLocal>["model"]
  language: ReturnType<typeof useLanguage>
  command: ReturnType<typeof useCommand>
  onClose: () => void
}): JSX.Element {
  return (
    <div data-component="prompt-model-control">
      <TooltipKeybind
        placement="top"
        gutter={4}
        title={props.language.t("command.model.choose")}
        keybind={props.command.keybind("model.choose")}
      >
        <ModelSelectorPopover
          model={props.model}
          triggerAs={Button}
          triggerProps={{
            variant: "ghost",
            size: "normal",
            style: props.triggerStyle(),
            class: "min-w-0 px-1.5 justify-start text-13-regular text-fg-base font-normal group",
            "data-action": "prompt-model",
            "data-picker-trigger": "",
            disabled: !props.actionReady(),
          }}
          onClose={props.onClose}
        >
          <Show when={props.model.current()?.provider?.id}>
            <ProviderIcon
              id={props.model.current()?.provider?.id ?? ""}
              class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
              style={{ "will-change": "opacity", transform: "translateZ(0)" }}
            />
          </Show>
          <span
            class="truncate text-center max-w-[7rem] transition-[max-width] duration-200 ease-out font-normal"
            classList={{ "@max-[28rem]/composer:max-w-0": !!props.model.current()?.provider?.id }}
          >
            {props.model.current()?.name ?? props.language.t("dialog.model.select.title")}
          </span>
          <Show when={props.model.variant.current()}>
            {(v) => (
              <span class="shrink-0 text-fg-weak font-normal">
                · {translateVariant(props.language.t, v())}
              </span>
            )}
          </Show>
          <Icon name="chevron-down" class="shrink-0" />
        </ModelSelectorPopover>
      </TooltipKeybind>
    </div>
  )
}
