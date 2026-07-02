import type { JSX } from "solid-js"
import type { AutomationRun } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"

type RunState = AutomationRun["state"]

export function runStatusLabelKey(state: RunState): string {
  return `automations.run.${state}`
}

// Run status reuses the sidebar's visual vocabulary: a spinner while running,
// the asking-comment glyph while blocked, and semantic check/cross otherwise.
export function RunStatusIcon(props: { state: RunState; label: string }): JSX.Element {
  switch (props.state) {
    case "running":
      return <Spinner aria-label={props.label} class="size-[16px]" style={{ color: "var(--brand-primary)" }} />
    case "awaiting_input":
      return <Icon name="comment" class="text-brand-primary" />
    case "succeeded":
      return <Icon name="circle-check" class="text-success-text" />
    case "failed":
      return <Icon name="circle-x" class="text-error" />
    case "stopped":
      return <Icon name="circle-ban-sign" class="text-icon-weak" />
    case "scheduled":
      return <Icon name="schedule" class="text-icon-weak" />
  }
}
