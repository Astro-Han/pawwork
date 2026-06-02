import { For, type Accessor, type JSX } from "solid-js"
import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { formatScheduleSummary } from "./automation-schedule"

export function AutomationList(props: {
  automations: Accessor<AutomationDefinition[]>
  onSelect: (id: string) => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <ul data-component="automation-list" class="flex flex-col gap-0.5">
      <For each={props.automations()}>
        {(automation) => (
          <li>
            <button
              type="button"
              data-action="automation-row"
              data-automation-id={automation.id}
              onClick={() => props.onSelect(automation.id)}
              class="w-full h-[36px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
              classList={{ "opacity-55": automation.paused }}
            >
              <span class="shrink-0 w-4 h-4 flex items-center">
                <Icon
                  name={automation.paused ? "circle-ban-sign" : "schedule"}
                  class={automation.paused ? "text-icon-weak" : "text-icon-base"}
                />
              </span>
              <span class="text-h3 text-fg-strong min-w-0 flex-1 truncate">{automation.title}</span>
              <span class="shrink-0 text-body text-fg-weak">{formatScheduleSummary(automation, language.t)}</span>
            </button>
          </li>
        )}
      </For>
    </ul>
  )
}
