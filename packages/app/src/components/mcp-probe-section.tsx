import type { McpStatus } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"

export function McpProbeSection(props: {
  result?: McpStatus
  pending: boolean
  onTest: () => void
}) {
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-2 border-t border-border-weak pt-4">
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <div class="text-body text-fg-strong">{language.t("settings.mcp.probe.title")}</div>
          <div class="text-small text-fg-weak">{language.t("settings.mcp.probe.description")}</div>
        </div>
        <Button type="button" variant="secondary" disabled={props.pending} onClick={props.onTest}>
          {props.pending ? language.t("settings.mcp.probe.testing") : language.t("settings.mcp.probe.action")}
        </Button>
      </div>
      <Show when={props.result}>{(result) => <McpProbeResult result={result()} />}</Show>
    </div>
  )
}

function McpProbeResult(props: { result: McpStatus }) {
  const language = useLanguage()
  const connected = () => props.result.status === "connected"
  const title = () => {
    if (props.result.status === "connected") return language.t("settings.mcp.probe.connected")
    if (props.result.status === "failed") return language.t("settings.mcp.probe.failed")
    if (props.result.status === "needs_auth") return language.t("settings.mcp.probe.needs_auth")
    if (props.result.status === "needs_client_registration")
      return language.t("settings.mcp.probe.needs_client_registration")
    return language.t("settings.mcp.probe.disabled")
  }
  const detail = () => {
    if (props.result.status === "failed") return props.result.error
    if (props.result.status === "connected") return language.t("settings.mcp.probe.connected.description")
    if (props.result.status === "needs_auth") return language.t("settings.mcp.probe.needs_auth.description")
    if (props.result.status === "needs_client_registration")
      return language.t("settings.mcp.probe.needs_client_registration.description")
    return language.t("settings.mcp.probe.disabled.description")
  }

  return (
    <div
      role="status"
      aria-live="polite"
      class="flex items-start gap-2 border-l-2 px-3 py-2"
      classList={{
        "border-success bg-success-bg": connected(),
        "border-error bg-error-bg": !connected(),
      }}
    >
      <Icon
        name={connected() ? "circle-check" : "circle-x"}
        class={connected() ? "mt-0.5 shrink-0 text-success-text" : "mt-0.5 shrink-0 text-error"}
      />
      <div class="min-w-0">
        <div class="text-body text-fg-strong">{title()}</div>
        <div class="break-words text-small text-fg-weak">{detail()}</div>
        <Show when={props.result.status === "failed"}>
          <div class="mt-1 text-small text-fg-weak">{language.t("settings.mcp.probe.failed.action")}</div>
        </Show>
      </div>
    </div>
  )
}
