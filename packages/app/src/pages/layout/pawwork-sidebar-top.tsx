import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import type { Accessor } from "solid-js"
import { useLanguage } from "@/context/language"

export function PawworkSidebarTop(props: {
  newSessionKeybind: Accessor<string | undefined>
  searchKeybind: Accessor<string | undefined>
  skillsActive: Accessor<boolean>
  skillsLabel: Accessor<string>
  automationsActive: Accessor<boolean>
  automationsLabel: Accessor<string>
  remoteActive: Accessor<boolean>
  remoteLabel: Accessor<string>
  onNew: () => void
  onSearch: () => void
  searchAvailable: Accessor<boolean>
  onOpenSkills: () => void
  onOpenAutomations: () => void
  onOpenRemote: () => void
}) {
  const language = useLanguage()
  return (
    <div data-component="pawwork-side-top" class="shrink-0 px-3 pt-3">
      <div class="flex flex-col gap-1">
        <TooltipKeybind
          placement="right"
          title={language.t("command.session.new")}
          keybind={props.newSessionKeybind() ?? ""}
        >
          <button
            type="button"
            data-action="pawwork-session-new"
            onClick={props.onNew}
            class="w-full h-[30px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="new-session" class="text-icon-base" />
            </span>
            <span class="text-h3 text-fg-base min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
          </button>
        </TooltipKeybind>
        <TooltipKeybind
          placement="right"
          title={language.t("sidebar.pawwork.search")}
          keybind={props.searchKeybind() ?? ""}
        >
          <button
            type="button"
            data-action="pawwork-session-search"
            disabled={!props.searchAvailable()}
            onClick={props.onSearch}
            class="w-full h-[30px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="magnifying-glass" class="text-icon-base" />
            </span>
            <span class="text-h3 text-fg-base min-w-0 flex-1 truncate">{language.t("sidebar.pawwork.search")}</span>
          </button>
        </TooltipKeybind>
        <TooltipKeybind placement="right" title={props.skillsLabel()} keybind="">
          <button
            type="button"
            data-action="pawwork-skills-open"
            aria-pressed={props.skillsActive()}
            onClick={props.onOpenSkills}
            class="w-full h-[30px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            classList={{ "bg-row-active-overlay hover:bg-row-active-overlay": props.skillsActive() }}
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="skill" class="text-icon-base" />
            </span>
            <span
              class="text-h3 text-fg-base min-w-0 flex-1 truncate"
              classList={{ "text-fg-strong font-emphasis": props.skillsActive() }}
            >
              {props.skillsLabel()}
            </span>
          </button>
        </TooltipKeybind>
        <TooltipKeybind placement="right" title={props.automationsLabel()} keybind="">
          <button
            type="button"
            data-action="pawwork-automations-open"
            aria-pressed={props.automationsActive()}
            onClick={props.onOpenAutomations}
            class="w-full h-[30px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            classList={{ "bg-row-active-overlay hover:bg-row-active-overlay": props.automationsActive() }}
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="automation" class="text-icon-base" />
            </span>
            <span
              class="text-h3 text-fg-base min-w-0 flex-1 truncate"
              classList={{ "text-fg-strong font-emphasis": props.automationsActive() }}
            >
              {props.automationsLabel()}
            </span>
          </button>
        </TooltipKeybind>
        <TooltipKeybind placement="right" title={props.remoteLabel()} keybind="">
          <button
            type="button"
            data-action="pawwork-remote-open"
            aria-pressed={props.remoteActive()}
            onClick={props.onOpenRemote}
            class="w-full h-[30px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            classList={{ "bg-row-active-overlay hover:bg-row-active-overlay": props.remoteActive() }}
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="remote-control" class="text-icon-base" />
            </span>
            <span
              class="text-h3 text-fg-base min-w-0 flex-1 truncate"
              classList={{ "text-fg-strong font-emphasis": props.remoteActive() }}
            >
              {props.remoteLabel()}
            </span>
          </button>
        </TooltipKeybind>
      </div>
    </div>
  )
}
