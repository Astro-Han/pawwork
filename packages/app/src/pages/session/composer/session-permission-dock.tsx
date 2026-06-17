import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

type Translate = ReturnType<typeof useLanguage>["t"]

export function canPersistPermission(request: Pick<PermissionRequest, "always">) {
  return request.always.length > 0
}

export function permissionMetadataLines(request: PermissionRequest, t: Translate): string[] {
  const metadata = request.metadata ?? {}
  if (
    request.permission === "automate_manage" &&
    metadata["action"] === "delete" &&
    typeof metadata["title"] === "string" &&
    typeof metadata["id"] === "string"
  ) {
    return [t("ui.permission.automateManageDelete", { title: metadata["title"], id: metadata["id"] })]
  }
  return []
}

export function SessionPermissionContent(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }
  const metadataLines = () => permissionMetadataLines(props.request, language.t)

  return (
    <div data-component="dock-prompt" data-kind="permission">
      <div data-slot="permission-body">
        <div data-slot="permission-header">
          <div data-slot="permission-row" data-variant="header">
            <span data-slot="permission-icon">
              <Icon name="warning" />
            </span>
            <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
          </div>
        </div>

        <div data-slot="permission-content">
          <Show when={toolDescription()}>
            <div data-slot="permission-row">
              <span data-slot="permission-spacer" aria-hidden="true" />
              <div data-slot="permission-hint">{toolDescription()}</div>
            </div>
          </Show>

          <For each={metadataLines()}>
            {(line) => (
              <div data-slot="permission-row">
                <span data-slot="permission-spacer" aria-hidden="true" />
                <div data-slot="permission-hint">{line}</div>
              </div>
            )}
          </For>

          <Show when={props.request.patterns.length > 0}>
            <div data-slot="permission-row">
              <span data-slot="permission-spacer" aria-hidden="true" />
              <div data-slot="permission-patterns">
                <For each={props.request.patterns}>
                  {(pattern) => <code class="text-mono-small text-fg-base break-all">{pattern}</code>}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <div data-slot="permission-footer">
        <div />
        <div data-slot="permission-footer-actions">
          <Button variant="ghost" onClick={() => props.onDecide("reject")} disabled={props.responding}>
            {language.t("ui.permission.deny")}
          </Button>
          <Show when={canPersistPermission(props.request)}>
            <Button variant="secondary" onClick={() => props.onDecide("always")} disabled={props.responding}>
              {language.t("ui.permission.allowAlways")}
            </Button>
          </Show>
          <Button variant="primary" onClick={() => props.onDecide("once")} disabled={props.responding}>
            {language.t("ui.permission.allowOnce")}
          </Button>
        </div>
      </div>
    </div>
  )
}
