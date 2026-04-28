import { For, Show, createEffect, createMemo, on, onCleanup, type Accessor, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServer, ServerConnection } from "@/context/server"
import { useSync } from "@/context/sync"
import { useCheckServerHealth, type ServerHealth } from "@/utils/server-health"

const POLL_MS = 10_000

type CategoryState = "ok" | "warn" | "empty"

function EmptyHint(props: { text: string }) {
  return <div class="text-13-regular text-text-weaker py-1">{props.text}</div>
}

function SectionRow(props: {
  title: string
  count: number
  state: CategoryState
  expanded: boolean
  onToggle: () => void
  children?: JSX.Element
}) {
  const dot = () => {
    if (props.state === "warn") return "bg-icon-critical-base"
    if (props.state === "ok") return "bg-icon-success-base"
    return "bg-border-weak-base"
  }
  return (
    <div class="border-b border-border-weaker-base last:border-b-0">
      <button
        type="button"
        class="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-surface-raised-base-hover text-left"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
      >
        <div class={`size-1.5 rounded-full shrink-0 ${dot()}`} aria-hidden />
        <div class="text-13-regular text-text-base">{props.title}</div>
        <div class="text-13-regular text-text-weaker">{props.count}</div>
        <div class="flex-1" />
        <Icon
          name="chevron-down"
          size="small"
          class="text-icon-weaker transition-transform"
          classList={{ "rotate-180": props.expanded }}
        />
      </button>
      <Show when={props.expanded}>
        <div class="px-4 pb-3">{props.children}</div>
      </Show>
    </div>
  )
}

export function SessionStatusConnections(props: { shown: Accessor<boolean> }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  const dialog = useDialog()

  const openServerPicker = () => {
    void import("@/components/dialog-select-server").then((x) => {
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  const checkServerHealth = useCheckServerHealth()
  const [health, setHealth] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)
  createEffect(() => {
    if (!props.shown()) {
      setHealth(reconcile({}))
      return
    }
    const list = server.list
    let dead = false
    let inFlight = false
    const refresh = async () => {
      // Skip overlapping probes so an old slow refresh can't overwrite a newer snapshot.
      if (inFlight) return
      inFlight = true
      try {
        const results: Record<string, ServerHealth | undefined> = {}
        // Per-probe try/catch so a single failing server doesn't abort the whole batch.
        // An unexpected throw from checkServerHealth (which normally catches network errors
        // itself) is treated as an explicit health failure so it surfaces as red rather than
        // silently staying grey/"unprobed".
        await Promise.all(
          list.map(async (conn) => {
            const key = ServerConnection.key(conn)
            try {
              results[key] = await checkServerHealth(conn.http)
            } catch {
              results[key] = { healthy: false }
            }
          }),
        )
        if (dead) return
        setHealth(reconcile(results))
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  const servers = createMemo(() => server.list)
  const serverState = createMemo<CategoryState>(() => {
    const list = servers()
    if (list.length === 0) return "empty"
    const anyBad = list.some((conn) => health[ServerConnection.key(conn)]?.healthy === false)
    if (anyBad) return "warn"
    const anyHealthy = list.some((conn) => health[ServerConnection.key(conn)]?.healthy === true)
    return anyHealthy ? "ok" : "empty"
  })

  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp ?? {}))
  const mcpState = createMemo<CategoryState>(() => {
    const entries = mcpEntries()
    if (entries.length === 0) return "empty"
    const anyBad = entries.some(
      ([, m]) => m?.status === "failed" || m?.status === "needs_auth" || m?.status === "needs_client_registration",
    )
    if (anyBad) return "warn"
    const anyConnected = entries.some(([, m]) => m?.status === "connected")
    return anyConnected ? "ok" : "empty"
  })

  const lspItems = createMemo(() => sync.data.lsp ?? [])
  const lspState = createMemo<CategoryState>(() => {
    const items = lspItems()
    if (items.length === 0) return "empty"
    const anyBad = items.some((it) => it.status === "error")
    if (anyBad) return "warn"
    const anyConnected = items.some((it) => it.status === "connected")
    return anyConnected ? "ok" : "empty"
  })

  const plugins = createMemo(() =>
    (sync.data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginState = createMemo<CategoryState>(() => (plugins().length === 0 ? "empty" : "ok"))

  const autoExpand = (state: CategoryState) => state === "warn"
  const [ui, setUi] = createStore({
    servers: autoExpand(serverState()),
    mcp: autoExpand(mcpState()),
    lsp: autoExpand(lspState()),
    plugins: false,
  })
  // Fire only on transition into warn, so a user's manual collapse is respected
  // until a fresh failure arrives.
  createEffect(
    on(serverState, (next, prev) => {
      if (next === "warn" && prev !== "warn") setUi("servers", true)
    }),
  )
  createEffect(
    on(mcpState, (next, prev) => {
      if (next === "warn" && prev !== "warn") setUi("mcp", true)
    }),
  )
  createEffect(
    on(lspState, (next, prev) => {
      if (next === "warn" && prev !== "warn") setUi("lsp", true)
    }),
  )

  return (
    <div class="flex flex-col">
      <div class="text-13-medium uppercase tracking-wide text-text-weaker px-4 py-3 pb-1">
        {language.t("status.connections.title")}
      </div>

      <SectionRow
        title={language.t("status.popover.tab.servers")}
        count={servers().length}
        state={serverState()}
        expanded={ui.servers}
        onToggle={() => setUi("servers", (v) => !v)}
      >
        <Show when={servers().length > 0} fallback={<EmptyHint text={language.t("status.connections.empty")} />}>
          <For each={servers()}>
            {(conn) => {
              const key = ServerConnection.key(conn)
              const dotClass = () => {
                const probe = health[key]?.healthy
                if (probe === false) return "bg-icon-critical-base"
                if (probe === true) return "bg-icon-success-base"
                // Unprobed / in-flight: match the aggregate grey so parent and row agree.
                return "bg-border-weak-base"
              }
              return (
                <div class="flex items-center gap-2 py-1">
                  <div class={`size-1.5 rounded-full shrink-0 ${dotClass()}`} aria-hidden />
                  <span class="text-13-regular text-text-base truncate min-w-0">{conn.http.url}</span>
                </div>
              )
            }}
          </For>
        </Show>
      </SectionRow>

      <SectionRow
        title={language.t("status.popover.tab.mcp")}
        count={mcpEntries().length}
        state={mcpState()}
        expanded={ui.mcp}
        onToggle={() => setUi("mcp", (v) => !v)}
      >
        <Show when={mcpEntries().length > 0} fallback={<EmptyHint text={language.t("status.connections.empty")} />}>
          <For each={mcpEntries()}>
            {([name, m]) => {
              const s = () => m?.status
              const bad = () => s() === "failed" || s() === "needs_auth" || s() === "needs_client_registration"
              const label = () => {
                if (s() === "connected") return undefined
                if (s() === "disabled") return language.t("status.connections.state.disabled")
                if (s() === "failed") return language.t("status.connections.state.failed")
                if (s() === "needs_auth") return language.t("status.connections.state.needs_auth")
                if (s() === "needs_client_registration")
                  return language.t("status.connections.state.needs_client_registration")
                return undefined
              }
              return (
                <div class="flex items-center gap-2 py-1">
                  <div
                    classList={{
                      "size-1.5 rounded-full shrink-0": true,
                      "bg-icon-critical-base": bad(),
                      "bg-icon-success-base": s() === "connected",
                      "bg-border-weak-base": s() === "disabled" || !s(),
                    }}
                    aria-hidden
                  />
                  <span class="text-13-regular text-text-base truncate min-w-0">{name}</span>
                  <Show when={label()}>
                    <span class="text-13-regular text-text-weaker ml-auto">{label()}</span>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
      </SectionRow>

      <SectionRow
        title={language.t("status.popover.tab.lsp")}
        count={lspItems().length}
        state={lspState()}
        expanded={ui.lsp}
        onToggle={() => setUi("lsp", (v) => !v)}
      >
        <Show when={lspItems().length > 0} fallback={<EmptyHint text={language.t("status.connections.empty")} />}>
          <For each={lspItems()}>
            {(item) => (
              <div class="flex items-center gap-2 py-1">
                <div
                  classList={{
                    "size-1.5 rounded-full shrink-0": true,
                    "bg-icon-critical-base": item.status === "error",
                    "bg-icon-success-base": item.status === "connected",
                    // Fallback for transient states (starting, stopped, unknown) so the dot stays visible.
                    "bg-border-weak-base": item.status !== "error" && item.status !== "connected",
                  }}
                  aria-hidden
                />
                <span class="text-13-regular text-text-base truncate min-w-0">{item.name || item.id}</span>
              </div>
            )}
          </For>
        </Show>
      </SectionRow>

      <SectionRow
        title={language.t("status.popover.tab.plugins")}
        count={plugins().length}
        state={pluginState()}
        expanded={ui.plugins}
        onToggle={() => setUi("plugins", (v) => !v)}
      >
        <Show when={plugins().length > 0} fallback={<EmptyHint text={language.t("status.connections.empty")} />}>
          <For each={plugins()}>
            {(plugin) => (
              <div class="flex items-center gap-2 py-1">
                <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" aria-hidden />
                <span class="text-13-regular text-text-base truncate min-w-0">{plugin}</span>
              </div>
            )}
          </For>
        </Show>
      </SectionRow>

      <div class="px-4 py-3">
        <Button variant="secondary" class="h-8 px-3 py-1.5" onClick={openServerPicker}>
          {language.t("status.popover.action.manageServers")}
        </Button>
      </div>
    </div>
  )
}
