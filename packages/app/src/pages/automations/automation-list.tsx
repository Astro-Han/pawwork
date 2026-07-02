import { For, type Accessor, type JSX } from "solid-js"
import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { formatScheduleSummary } from "./automation-schedule"

type AutomationListItem = {
  definition: AutomationDefinition
  projectName: string
}

export function AutomationList(props: {
  items: Accessor<AutomationListItem[]>
  onSelect: (id: string) => void
  onToggleActive: (automation: AutomationDefinition) => void
  onRunNow: (automation: AutomationDefinition) => void
  onDelete: (automation: AutomationDefinition) => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <ul data-component="automation-list" class="flex flex-col gap-0.5">
      <For each={props.items()}>
        {(item) => {
          const automation = item.definition
          return (
            <li class="group/automation relative">
              <button
                type="button"
                data-action="automation-row"
                data-automation-id={automation.id}
                onClick={() => props.onSelect(automation.id)}
                class="w-full h-[44px] flex items-center gap-3 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
                classList={{ "opacity-55": automation.paused }}
              >
                <span class="shrink-0 w-4 h-4 flex items-center">
                  <Icon
                    name={automation.paused ? "circle-ban-sign" : "schedule"}
                    class={automation.paused ? "text-icon-weak" : "text-icon-base"}
                  />
                </span>
                <span class="min-w-0 flex flex-1 flex-col gap-0.5">
                  <span class="truncate text-h3 text-fg-strong">{automation.title}</span>
                  <span class="truncate text-caption text-fg-weak">{item.projectName}</span>
                </span>
                <span class="shrink-0 text-body text-fg-weak group-hover/automation:opacity-0 group-focus-within/automation:opacity-0">
                  {formatScheduleSummary(automation, language.t)}
                </span>
              </button>
              {/* Same three actions as the detail header, surfaced on hover in
                  place of the schedule summary. Siblings of the row button, so
                  clicking one never opens the row. */}
              <div
                data-component="automation-row-actions"
                class="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/automation:opacity-100 group-focus-within/automation:opacity-100"
              >
                <Button
                  variant="ghost"
                  icon="trash"
                  data-action="automation-delete"
                  data-automation-id={automation.id}
                  aria-label={language.t("automations.action.delete")}
                  onClick={() => props.onDelete(automation)}
                />
                <Button
                  variant="ghost"
                  icon={automation.paused ? "play" : "pause"}
                  data-action="automation-toggle-active"
                  data-automation-id={automation.id}
                  aria-label={
                    automation.paused ? language.t("automations.action.resume") : language.t("automations.action.pause")
                  }
                  onClick={() => props.onToggleActive(automation)}
                />
                <Button
                  variant="ghost"
                  icon="play"
                  data-action="automation-run-now"
                  data-automation-id={automation.id}
                  aria-label={language.t("automations.action.runNow")}
                  onClick={() => props.onRunNow(automation)}
                />
              </div>
            </li>
          )
        }}
      </For>
    </ul>
  )
}
