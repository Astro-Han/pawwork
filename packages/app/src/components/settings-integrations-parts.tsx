import { type JSX, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

// Shared presentational pieces for the Integrations settings surface. Kept in one
// small file so the page and the MCP section render identical chrome without
// either owning the other's markup.

export type ItemState = "ok" | "warn" | "neutral"

export function StatusIcon(props: { state: ItemState }) {
  if (props.state === "warn") return <Icon name="circle-x" class="shrink-0 text-error" aria-hidden />
  if (props.state === "ok") return <Icon name="circle-check" class="shrink-0 text-icon-success-base" aria-hidden />
  return <Icon name="circle" class="shrink-0 text-icon-weak" aria-hidden />
}

export function ItemRow(props: { name: string; state: ItemState; status?: string; bad?: boolean }) {
  return (
    <li class="flex items-center gap-3 py-2.5 border-b border-border-weak last:border-none">
      <StatusIcon state={props.state} />
      <span class="truncate text-body text-fg-base flex-1 min-w-0">{props.name}</span>
      <Show when={props.status}>
        <span
          class="text-small shrink-0"
          classList={{
            "text-error": props.bad,
            "text-fg-weak": !props.bad,
          }}
        >
          {props.status}
        </span>
      </Show>
    </li>
  )
}

export function EmptyHint(props: { text: string }) {
  return <div class="py-3 text-body text-fg-weaker">{props.text}</div>
}

export function SectionHeader(props: { title: string; count: number; action?: () => JSX.Element }) {
  return (
    <div class="flex items-center justify-between pb-2 pt-6">
      <h3 class="text-h3 text-fg-strong">
        {props.title} <span class="text-fg-weak font-normal">{props.count}</span>
      </h3>
      <Show when={props.action}>{props.action?.()}</Show>
    </div>
  )
}
