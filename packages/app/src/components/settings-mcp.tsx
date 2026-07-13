import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { For, Show, createMemo, createSignal } from "solid-js"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync, type McpRawEntry } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { McpForm } from "@/components/mcp-form"
import { McpDeleteDialog } from "@/components/mcp-delete-dialog"
import { EmptyHint, type ItemState, SectionHeader, StatusIcon } from "@/components/settings-integrations-parts"

type McpConfig = McpLocalConfig | McpRemoteConfig

type McpEntry = {
  name: string
  config: McpRawEntry
  // A full local/remote config the MCP Sheet can edit. A legacy `{ enabled }`
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
// jumps); add / edit happen in a focused Sheet, while deletion is confirmed in
// a Dialog. Presence is
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
  const [editor, setEditor] = createSignal<
    { mode: "add" } | { mode: "edit"; name: string; config: McpConfig } | undefined
  >(undefined)

  const childStore = createMemo(() => {
    const dir = props.directory
    if (!dir) return undefined
    const [store] = globalSync.child(dir, { bootstrap: false })
    return store
  })

  const globalMcp = createMemo(() => globalSync.data.mcpRaw)
  const invalid = createMemo(() => globalSync.data.mcpInvalid)
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
    if (!status) return language.t("settings.mcp.status.notChecked")
    if (status === "connected") return language.t("settings.mcp.status.connected")
    if (status === "disabled") return language.t("status.connections.state.disabled")
    if (status === "failed") return language.t("status.connections.state.failed")
    if (status === "needs_auth") return language.t("status.connections.state.needs_auth")
    if (status === "needs_client_registration") return language.t("status.connections.state.needs_client_registration")
    return undefined
  }

  const summary = (entry: McpEntry) => {
    const config = entry.editable
    if (!config) return language.t("settings.mcp.summary.legacy")
    if (config.type === "remote") return language.t("settings.mcp.summary.remote", { value: config.url })
    return language.t("settings.mcp.summary.local", { value: config.command.join(" ") })
  }

  const openAdd = () => setEditor({ mode: "add" })

  const openEdit = (entry: McpEntry) => {
    const config = entry.editable
    if (!config) return
    setEditor({ mode: "edit", name: entry.name, config })
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

  const remove = useMutation(() => ({
    mutationFn: async (name: string) => globalSync.editMcp({ remove: [name] }),
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("settings.mcp.toast.deleteFailed.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    },
  }))

  const confirmLegacyDelete = (name: string) =>
    dialog.show(() => <McpDeleteDialog name={name} onDelete={() => remove.mutateAsync(name)} />)

  const repair = useMutation(() => ({
    mutationFn: () => globalSync.repairMcp(),
    onSuccess: (result) => {
      showToast({
        variant: "success",
        title: language.t("settings.mcp.repair.success.title"),
        description: language.t("settings.mcp.repair.success.description", {
          path: result?.backups?.[0] ?? "",
        }),
      })
    },
    onError: (error) => {
      showToast({
        variant: "error",
        title: language.t("settings.mcp.repair.failed.title"),
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
      <Show when={invalid().length > 0}>
        <div class="my-2 flex items-start gap-3 border-l-2 border-warning bg-warning-bg px-3 py-2.5">
          <Icon name="warning" class="mt-0.5 shrink-0 text-warning-text" />
          <div class="min-w-0 flex-1">
            <div class="text-body text-fg-strong">{language.t("settings.mcp.repair.title")}</div>
            <div class="text-small text-fg-weak">
              {language.t("settings.mcp.repair.description", {
                names: invalid().map((name) => (name === "$mcp" ? "MCP" : name)).join(", "),
              })}
            </div>
          </div>
          <Button variant="secondary" size="small" disabled={repair.isPending} onClick={() => repair.mutate()}>
            {repair.isPending ? language.t("settings.mcp.repair.repairing") : language.t("settings.mcp.repair.action")}
          </Button>
        </div>
      </Show>
      <Show when={entries().length > 0} fallback={<EmptyHint text={language.t("settings.integrations.empty")} />}>
        <ul class="flex flex-col">
          <For each={entries()}>
            {(entry) => (
              <li class="flex items-center gap-3 py-2 border-b border-border-weak last:border-none">
                <StatusIcon state={stateOf(entry.status)} />
                <div class="flex flex-col min-w-0 flex-1">
                  <span class="truncate text-body font-emphasis text-fg-base">{entry.name}</span>
                  <span class="truncate text-small text-fg-weaker">{summary(entry)}</span>
                  <Show when={entry.error}>
                    <span class="truncate text-small text-error-text">{entry.error}</span>
                  </Show>
                </div>
                <span
                  class="text-small shrink-0"
                  classList={{ "text-error": stateOf(entry.status) === "warn", "text-fg-weak": stateOf(entry.status) !== "warn" }}
                >
                  {statusLabel(entry.status)}
                </span>
                <Switch
                  checked={entry.enabled}
                  disabled={toggle.isPending}
                  onChange={() => toggle.mutate(entry)}
                  hideLabel
                >
                  {language.t("settings.mcp.toggle", { name: entry.name })}
                </Switch>
                <Show
                  when={entry.editable}
                  fallback={
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      class="text-error"
                      disabled={remove.isPending}
                      onClick={() => confirmLegacyDelete(entry.name)}
                      aria-label={language.t("settings.mcp.delete", { name: entry.name })}
                    />
                  }
                >
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
      <Show when={editor()}>
        {(current) => {
          const selected = current()
          return (
            <McpForm
              open
              onOpenChange={(open) => !open && setEditor(undefined)}
              mode={selected.mode}
              name={selected.mode === "edit" ? selected.name : undefined}
              config={selected.mode === "edit" ? selected.config : undefined}
              existingNames={existingNames()}
              directory={props.directory}
            />
          )
        }}
      </Show>
    </>
  )
}
