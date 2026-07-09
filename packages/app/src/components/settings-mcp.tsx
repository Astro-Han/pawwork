import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { For, Show, createMemo } from "solid-js"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync, type McpRawEntry } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { DialogMcpForm } from "@/components/dialog-mcp-form"
import { EmptyHint, type ItemState, SectionHeader, StatusDot } from "@/components/settings-integrations-parts"

type McpConfig = McpLocalConfig | McpRemoteConfig

type McpEntry = {
  name: string
  config: McpRawEntry
  // A full local/remote config the DialogMcpForm can edit. A legacy `{ enabled }`
  // override has no `type`, so it can only be toggled or deleted, not edited.
  editable: McpConfig | undefined
  enabled: boolean
  status?: McpStatus["status"]
  error?: string
}

function asEditable(config: McpRawEntry): McpConfig | undefined {
  if (!config || typeof config !== "object") return undefined
  return "type" in config && (config.type === "local" || config.type === "remote") ? config : undefined
}

// MCP section of the Integrations settings page. The list is inline (page never
// jumps); add / edit / delete happen in a focused DialogMcpForm. Presence is
// driven purely by the raw global config (fresh after every editMcp
// re-bootstrap), so a deleted server disappears immediately without waiting on a
// child-store refresh. The raw map keeps `{env:...}` / `{file:...}` placeholders
// unexpanded, so an edit or toggle round-trips the literal file content and
// never persists a resolved secret. Per the v1 global-only management scope,
// project-scoped MCP servers live in project config and are not surfaced here;
// runtime connection status is layered on by name as best-effort enrichment.
export function SettingsMcp(props: { directory?: string }) {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  const childStore = createMemo(() => {
    const dir = props.directory
    if (!dir) return undefined
    const [store] = globalSync.child(dir, { bootstrap: false })
    return store
  })

  const globalMcp = createMemo(() => globalSync.data.mcpRaw)
  const runtime = createMemo(() => childStore()?.mcp ?? {})

  const entries = createMemo<McpEntry[]>(() => {
    const global = globalMcp()
    const status = runtime()
    return Object.keys(global)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const config = global[name]
        const runtimeStatus = status[name]
        return {
          name,
          config,
          editable: asEditable(config),
          enabled: config?.enabled !== false,
          status: runtimeStatus?.status,
          error: runtimeStatus?.status === "failed" ? runtimeStatus.error : undefined,
        }
      })
  })

  const existingNames = createMemo(() => Object.keys(globalMcp()))

  const stateOf = (status?: McpStatus["status"]): ItemState => {
    if (status === "failed" || status === "needs_auth" || status === "needs_client_registration") return "warn"
    if (status === "connected") return "ok"
    return "neutral"
  }

  const statusLabel = (status?: McpStatus["status"]) => {
    if (!status || status === "connected") return undefined
    if (status === "disabled") return language.t("status.connections.state.disabled")
    if (status === "failed") return language.t("status.connections.state.failed")
    if (status === "needs_auth") return language.t("status.connections.state.needs_auth")
    if (status === "needs_client_registration") return language.t("status.connections.state.needs_client_registration")
    return undefined
  }

  const openAdd = () =>
    dialog.show(() => <DialogMcpForm mode="add" existingNames={existingNames()} />)

  const openEdit = (entry: McpEntry) => {
    const config = entry.editable
    if (!config) return
    dialog.show(() => <DialogMcpForm mode="edit" name={entry.name} config={config} existingNames={existingNames()} />)
  }

  const toggle = useMutation(() => ({
    mutationFn: async (entry: McpEntry) => {
      // Field-level patch: only the `enabled` key is written, so the rest of the
      // raw entry (including any unexpanded secret placeholder) stays untouched.
      await globalSync.editMcp({ enable: { [entry.name]: !entry.enabled } })
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("settings.mcp.toast.saveFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  return (
    <>
      <SectionHeader
        title={language.t("status.popover.tab.mcp")}
        count={entries().length}
        action={() => (
          <Button variant="secondary" size="small" icon="plus-small" onClick={openAdd}>
            {language.t("settings.mcp.add")}
          </Button>
        )}
      />
      <Show when={entries().length > 0} fallback={<EmptyHint text={language.t("settings.integrations.empty")} />}>
        <ul class="flex flex-col">
          <For each={entries()}>
            {(entry) => (
              <li class="flex items-center gap-3 py-2 border-b border-border-weak last:border-none">
                <StatusDot state={stateOf(entry.status)} />
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="truncate text-body text-fg-base">{entry.name}</span>
                  <Show when={entry.error}>
                    <span class="truncate text-small text-fg-weaker">{entry.error}</span>
                  </Show>
                </div>
                <Show when={statusLabel(entry.status)}>
                  {(label) => (
                    <span
                      class="text-small shrink-0"
                      classList={{ "text-error": stateOf(entry.status) === "warn", "text-fg-weak": stateOf(entry.status) !== "warn" }}
                    >
                      {label()}
                    </span>
                  )}
                </Show>
                <Switch
                  checked={entry.enabled}
                  disabled={toggle.isPending}
                  onChange={() => toggle.mutate(entry)}
                  hideLabel
                >
                  {language.t("settings.mcp.toggle", { name: entry.name })}
                </Switch>
                <Show when={entry.editable}>
                  <IconButton
                    icon="edit"
                    variant="ghost"
                    onClick={() => openEdit(entry)}
                    aria-label={language.t("settings.mcp.edit")}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}
