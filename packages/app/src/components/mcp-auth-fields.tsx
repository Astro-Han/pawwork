import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show } from "solid-js"
import type { McpAuthMode } from "@/components/mcp-auth-form"
import { McpKvRows, type McpKvRow } from "@/components/mcp-kv-rows"
import { useLanguage } from "@/context/language"

export function McpAuthFields(props: {
  mode: McpAuthMode
  token: string
  headers: McpKvRow[]
  onModeChange: (mode: McpAuthMode) => void
  onTokenChange: (value: string) => void
  onAddHeader: () => void
  onRemoveHeader: (index: number) => void
  onHeaderChange: (index: number, key: "key" | "value", value: string) => void
}) {
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-3 border-t border-border-weak pt-4">
      <div>
        <div class="text-body text-fg-strong">{language.t("settings.mcp.auth.title")}</div>
        <div class="text-small text-fg-weak">{language.t("settings.mcp.auth.description")}</div>
      </div>
      <div class="flex w-max gap-1" role="group" aria-label={language.t("settings.mcp.auth.title")}>
        <For each={["bearer", "headers"] as McpAuthMode[]}>
          {(mode) => (
            <Button
              type="button"
              variant={props.mode === mode ? "secondary" : "ghost"}
              aria-pressed={props.mode === mode}
              onClick={() => props.onModeChange(mode)}
            >
              {language.t(`settings.mcp.auth.mode.${mode}`)}
            </Button>
          )}
        </For>
      </div>
      <Show
        when={props.mode === "bearer"}
        fallback={
          <McpKvRows
            label={language.t("settings.mcp.field.headers")}
            description={language.t("settings.mcp.field.headers.description")}
            addLabel={language.t("settings.mcp.field.headers.add")}
            removeLabel={language.t("settings.mcp.field.headers.remove")}
            keyPlaceholder={language.t("settings.mcp.field.header.key.placeholder")}
            valuePlaceholder={language.t("settings.mcp.field.header.value.placeholder")}
            rows={props.headers}
            maskValue
            onAdd={props.onAddHeader}
            onRemove={props.onRemoveHeader}
            onChange={props.onHeaderChange}
          />
        }
      >
        <TextField
          type="password"
          label={language.t("settings.mcp.auth.token")}
          placeholder={language.t("settings.mcp.auth.token.placeholder")}
          description={language.t("settings.mcp.auth.token.description")}
          value={props.token}
          onChange={props.onTokenChange}
        />
      </Show>
    </div>
  )
}
