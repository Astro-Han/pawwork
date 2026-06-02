import type { JSX } from "solid-js"
import type { AutomationDefinition } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { formatScheduleSummary } from "./automation-schedule"

export function AutomationDetail(props: {
  automation: AutomationDefinition
  onBack: () => void
}): JSX.Element {
  const language = useLanguage()
  return (
    <div data-component="automation-detail" class="flex flex-col gap-4">
      <nav class="flex items-center gap-1 text-body text-fg-weak">
        <button
          type="button"
          data-action="automation-detail-back"
          onClick={props.onBack}
          class="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay focus:outline-none"
        >
          <Icon name="chevron-left" class="w-3.5 h-3.5 text-icon-weak" />
          {language.t("automations.title")}
        </button>
      </nav>

      <header class="flex flex-col gap-1">
        <h1 class="text-h2 text-fg-strong">{props.automation.title}</h1>
        <p class="text-body text-fg-weak">{formatScheduleSummary(props.automation, language.t)}</p>
      </header>

      <p class="whitespace-pre-wrap text-body text-fg-base">{props.automation.prompt}</p>
    </div>
  )
}
