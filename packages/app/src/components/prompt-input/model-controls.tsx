// Composer bottom-bar model + variant controls. Each renders its own
// TooltipKeybind + selector. variantOpen state is owned by PromptInput
// (paired with the close-on-disable effect there) so this file stays
// stateless.

import { createMemo, Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
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
          <Icon name="chevron-down" class="shrink-0" />
        </ModelSelectorPopover>
      </TooltipKeybind>
    </div>
  )
}

export function PromptVariantControl(props: {
  triggerStyle: TriggerStyle
  open: boolean
  onOpenChange: (open: boolean) => void
  actionReady: () => boolean
  model: ReturnType<typeof useLocal>["model"]
  language: ReturnType<typeof useLanguage>
  command: ReturnType<typeof useCommand>
}): JSX.Element {
  const variants = createMemo(() => ["default", ...props.model.variant.list()])

  return (
    <div data-component="prompt-variant-control">
      <TooltipKeybind
        placement="top"
        gutter={4}
        title={props.language.t("command.model.variant.cycle")}
        keybind={props.command.keybind("model.variant.cycle")}
      >
        <Select<string>
          open={props.open}
          options={variants()}
          current={props.model.variant.current() ?? "default"}
          value={(v) => v}
          label={(v) => translateVariant(props.language.t, v)}
          onSelect={(v) => {
            if (!props.actionReady() || !v) return
            props.model.variant.set(v === "default" ? undefined : v)
          }}
          onOpenChange={props.onOpenChange}
          variant="ghost"
          size="normal"
          disabled={!props.actionReady()}
          triggerStyle={props.triggerStyle()}
          triggerProps={{
            "data-action": "prompt-model-variant",
            class:
              "max-w-[160px] @max-[20rem]/composer:max-w-[80px] text-13-regular text-fg-base font-normal",
          }}
        />
      </TooltipKeybind>
    </div>
  )
}
