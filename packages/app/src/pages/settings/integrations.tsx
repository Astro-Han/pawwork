import { type Component, For, type JSX, Show, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useConnectionHealth } from "@/context/connection-health"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useServer, ServerConnection } from "@/context/server"
import { useSettings } from "@/context/settings"
import { SettingsList } from "@/components/settings-list"
import { SettingsRow } from "@/components/settings-row"

type ItemState = "ok" | "warn" | "neutral"

function StatusDot(props: { state: ItemState }) {
  const className = () => {
    if (props.state === "warn") return "size-1.5 rounded-full shrink-0 bg-error"
    if (props.state === "ok") return "size-1.5 rounded-full shrink-0 bg-icon-success-base"
    return "size-1.5 rounded-full shrink-0 bg-border-weak"
  }
  return <div class={className()} aria-hidden />
}

function ItemRow(props: { name: string; state: ItemState; status?: string; bad?: boolean }) {
  return (
    <li class="flex items-center gap-3 py-2.5 border-b border-border-weak last:border-none">
      <StatusDot state={props.state} />
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

function EmptyHint(props: { text: string }) {
  return <div class="py-3 text-body text-fg-weaker">{props.text}</div>
}

function SectionHeader(props: { title: string; count: number; action?: () => JSX.Element }) {
  return (
    <div class="flex items-center justify-between pb-2 pt-6">
      <h3 class="text-h3 text-fg-strong">
        {props.title} <span class="text-fg-weak font-normal">{props.count}</span>
      </h3>
      <Show when={props.action}>{props.action?.()}</Show>
    </div>
  )
}

// Integrations page: rewires the right-panel Connections section as a Settings
// surface. Reads MCP / LSP / plugins from the per-directory global-sync child
// store, server health from ConnectionHealth (no second poll). Layout mirrors
// the established Settings page shape: SettingsList → h2 + description → flat
// h3 sections with bottom-bordered list items, same as Worktrees / General.
export const IntegrationsPage: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const sync = useGlobalSync()
  const settings = useSettings()
  const health = useConnectionHealth()
  const dialog = useDialog()

  const childStore = createMemo(() => {
    const dir = props.directory
    if (!dir) return undefined
    const [store] = sync.child(dir, { bootstrap: false })
    return store
  })

  const openServerPicker = () => {
    void import("@/components/dialog-select-server").then((m) => {
      dialog.show(() => <m.DialogSelectServer />)
    })
  }

  const servers = createMemo(() => server.list)
  const mcpEntries = createMemo(() => Object.entries(childStore()?.mcp ?? {}))
  const lspItems = createMemo(() => childStore()?.lsp ?? [])
  const plugins = createMemo(() =>
    (childStore()?.config?.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )

  return (
    <SettingsList>
      <div data-component="settings-integrations" class="flex flex-col gap-1 pt-6 pb-2 max-w-[720px]">
        <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.integrations")}</h2>
        <p class="text-body text-fg-weak">{language.t("settings.integrations.description")}</p>
      </div>

      <SectionHeader
        title={language.t("status.popover.tab.servers")}
        count={servers().length}
        action={() => (
          <Button variant="secondary" size="small" onClick={openServerPicker}>
            {language.t("status.popover.action.manageServers")}
          </Button>
        )}
      />
      <Show when={servers().length > 0} fallback={<EmptyHint text={language.t("settings.integrations.empty")} />}>
        <ul class="flex flex-col">
          <For each={servers()}>
            {(conn) => {
              const key = ServerConnection.key(conn)
              const probe = () => health.serverHealth[key]?.healthy
              const state = (): ItemState => {
                if (probe() === false) return "warn"
                if (probe() === true) return "ok"
                return "neutral"
              }
              const status = () => {
                if (probe() === false) return language.t("status.connections.state.failed")
                if (probe() === true) return undefined
                return undefined
              }
              return <ItemRow name={conn.http.url} state={state()} status={status()} bad={probe() === false} />
            }}
          </For>
        </ul>
      </Show>

      <SectionHeader title={language.t("status.popover.tab.mcp")} count={mcpEntries().length} />
      <Show when={mcpEntries().length > 0} fallback={<EmptyHint text={language.t("settings.integrations.empty")} />}>
        <ul class="flex flex-col">
          <For each={mcpEntries()}>
            {([name, m]) => {
              const s = () => m?.status
              const bad = () =>
                s() === "failed" || s() === "needs_auth" || s() === "needs_client_registration"
              const state = (): ItemState => {
                if (bad()) return "warn"
                if (s() === "connected") return "ok"
                return "neutral"
              }
              const status = () => {
                if (s() === "connected") return undefined
                if (s() === "disabled") return language.t("status.connections.state.disabled")
                if (s() === "failed") return language.t("status.connections.state.failed")
                if (s() === "needs_auth") return language.t("status.connections.state.needs_auth")
                if (s() === "needs_client_registration")
                  return language.t("status.connections.state.needs_client_registration")
                return undefined
              }
              return <ItemRow name={name} state={state()} status={status()} bad={bad()} />
            }}
          </For>
        </ul>
      </Show>

      <SectionHeader title={language.t("status.popover.tab.lsp")} count={lspItems().length} />
      <SettingsRow
        title={language.t("settings.general.row.lsp.title")}
        description={language.t("settings.general.row.lsp.description")}
      >
        <div data-action="settings-lsp-enabled">
          <Switch
            checked={settings.general.lspEnabled()}
            onChange={(checked) => settings.general.setLspEnabled(checked)}
          />
        </div>
      </SettingsRow>
      <Show when={lspItems().length > 0} fallback={<EmptyHint text={language.t("settings.integrations.empty")} />}>
        <ul class="flex flex-col">
          <For each={lspItems()}>
            {(item) => {
              const state = (): ItemState => {
                if (item.status === "error") return "warn"
                if (item.status === "connected") return "ok"
                return "neutral"
              }
              return (
                <ItemRow
                  name={item.name || item.id}
                  state={state()}
                  status={item.status === "error" ? language.t("status.connections.state.failed") : undefined}
                  bad={item.status === "error"}
                />
              )
            }}
          </For>
        </ul>
      </Show>

      <SectionHeader title={language.t("status.popover.tab.plugins")} count={plugins().length} />
      <Show when={plugins().length > 0} fallback={<EmptyHint text={language.t("settings.integrations.empty")} />}>
        <ul class="flex flex-col">
          <For each={plugins()}>{(plugin) => <ItemRow name={plugin} state="ok" />}</For>
        </ul>
      </Show>

      <div class="pb-10" />
    </SettingsList>
  )
}
