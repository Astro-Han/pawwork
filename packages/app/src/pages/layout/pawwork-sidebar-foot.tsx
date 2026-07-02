import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import type { Accessor } from "solid-js"

export function PawworkSidebarFoot(props: {
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
}) {
  return (
    <div data-component="pawwork-side-foot" class="shrink-0 px-3 pt-4 pb-3">
      <TooltipKeybind placement="top" title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
        <button
          type="button"
          data-action="pawwork-open-settings"
          onClick={props.onOpenSettings}
          aria-label={props.settingsLabel()}
          class="w-full h-[30px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
        >
          <span class="shrink-0 w-4 h-4 flex items-center">
            <Icon name="settings-gear" class="text-icon-base" />
          </span>
          <span class="text-h3 text-fg-base min-w-0 flex-1 truncate">{props.settingsLabel()}</span>
        </button>
      </TooltipKeybind>
    </div>
  )
}
