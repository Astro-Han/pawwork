// Bottom action bar of the composer: attach / model / workspace chips on the
// left, context-usage + send-or-stop on the right. Owns the button-reveal
// spring (driven by mode) and the send/stop tooltip, since both exist only to
// serve these controls.

import { createMemo, Show, type Accessor, type JSX } from "solid-js"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { SessionContextUsage } from "@/components/session-context-usage"
import type { useCommand } from "@/context/command"
import type { useLanguage } from "@/context/language"
import type { useLocal } from "@/context/local"
import { PromptModelControl } from "./model-controls"
import { WorkspaceChip } from "./workspace-chip"
import { SendButton } from "./send-button"
import { promptSendDisabled } from "./readiness"
import type { PromptStore } from "./store-types"

export interface PromptActionBarProps {
  mode: PromptStore["mode"]
  homeMode?: boolean
  language: ReturnType<typeof useLanguage>
  command: ReturnType<typeof useCommand>
  model: ReturnType<typeof useLocal>["model"]
  actionReady: Accessor<boolean>
  working: Accessor<boolean>
  abortReady: Accessor<boolean>
  blank: Accessor<boolean>
  stopping: Accessor<boolean>
  pick: () => void
  restoreFocus: () => void
}

export function PromptActionBar(props: PromptActionBarProps): JSX.Element {
  const buttonsSpring = useSpring(() => (props.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.95 + value * 0.05})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))

  const tip = () => {
    if (props.stopping() && props.abortReady()) {
      return (
        <div class="flex items-center gap-2">
          <span>{props.language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-h3 text-[10px]!">{props.language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{props.language.t("prompt.action.send")}</span>
        <Icon name="enter" class="text-icon-base" />
      </div>
    )
  }

  return (
    <div class="pointer-events-none absolute inset-x-4 bottom-3 flex items-center justify-between gap-2">
      <div
        aria-hidden={props.mode !== "normal"}
        class="pointer-events-auto flex min-w-0 items-center gap-1"
        style={{
          "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
        }}
      >
        <TooltipKeybind
          placement="top"
          title={props.language.t("prompt.action.attachFile")}
          keybind={props.command.keybind("file.attach")}
        >
          <IconButton
            icon="plus"
            data-action="prompt-attach"
            type="button"
            style={buttons()}
            onClick={props.pick}
            disabled={props.mode !== "normal" || !props.actionReady()}
            tabIndex={props.mode === "normal" ? undefined : -1}
            aria-label={props.language.t("prompt.action.attachFile")}
          />
        </TooltipKeybind>
        <Show when={props.mode === "normal"}>
          <PromptModelControl
            triggerStyle={buttons}
            actionReady={props.actionReady}
            model={props.model}
            language={props.language}
            command={props.command}
            onClose={props.restoreFocus}
          />
        </Show>
        <Show when={props.homeMode && props.mode === "normal"}>
          <WorkspaceChip style={buttons()} />
        </Show>
      </div>

      <div class="flex items-center gap-2 pointer-events-auto">
        <SessionContextUsage placement="top" />
        <Tooltip
          placement="top"
          inactive={(props.working() ? props.abortReady() : props.actionReady()) && !props.working() && props.blank()}
          value={tip()}
        >
          <SendButton
            stopping={props.stopping()}
            disabled={promptSendDisabled({
              stopping: props.stopping(),
              actionReady: props.actionReady(),
              abortReady: props.abortReady(),
              blank: props.blank(),
            })}
            aria-label={props.stopping() ? props.language.t("prompt.action.stop") : props.language.t("prompt.action.send")}
          />
        </Tooltip>
      </div>
    </div>
  )
}
