import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useParams } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useServer, ServerConnection } from "@/context/server"
import { useCheckServerHealth, type ServerHealth } from "@/utils/server-health"
import { decode64 } from "@/utils/base64"
import { openSettingsTab } from "@/utils/settings-navigation"

const POLL_MS = 10_000

// Single source for "is connection X currently broken" across the app.
// Replaces the session-scoped poll that used to live in
// SessionStatusConnections. Owns:
//   1) A 10s HTTP probe of every configured server (the only category that
//      actually needs polling — MCP/LSP push their status through global-sync).
//   2) Fire-once-per-transition Toasts when something flips healthy → broken,
//      coalesced per category. Same broken state does not re-fire until the
//      connection recovers; that matches the "alert me on change, do not
//      nag" contract agreed in #862's follow-up.
//   3) A read API (serverHealth) for the Settings.Integrations page so it can
//      render the same status dots without spinning up its own poll.
//
// Mounted at AppShellProviders level so the poll continues even when the
// Settings overlay is closed. MCP/LSP/plugin data is read off the current
// directory's child store on the global sync; when no directory is active
// (e.g. at the home route) the MCP/LSP observers are inert.

export const { use: useConnectionHealth, provider: ConnectionHealthProvider } = createSimpleContext({
  name: "ConnectionHealth",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const globalSync = useGlobalSync()
    const checkServerHealth = useCheckServerHealth()
    const params = useParams()

    const directory = createMemo(() => {
      const dir = params.dir
      if (!dir) return ""
      return decode64(dir) ?? ""
    })

    const [serverHealth, setServerHealth] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

    // Per-key "we have already toasted this as broken" flags. Reset back to
    // false when the connection becomes healthy again so the next transition
    // re-notifies. Unknown → broken counts as a transition (covers the
    // "started up and it was already broken" case agreed in shape).
    const notified = {
      server: new Set<string>(),
      mcp: new Set<string>(),
      lsp: new Set<string>(),
    }

    const fireToast = (category: "server" | "mcp" | "lsp", count: number) => {
      const titleKey = `connectionHealth.toast.${category}.title`
      const descriptionKey = `connectionHealth.toast.${category}.description`
      showToast({
        variant: "error",
        title: language.t(titleKey),
        description: language.t(descriptionKey, { count: String(count) }),
        actions: [
          {
            label: language.t("connectionHealth.toast.action.view"),
            onClick: () => openSettingsTab("integrations"),
          },
        ],
      })
    }

    const reconcileCategory = (category: "server" | "mcp" | "lsp", currentBad: Set<string>) => {
      const seen = notified[category]
      // Drop "previously notified" entries that have since recovered: when
      // they break again next time, fire the Toast again.
      for (const key of [...seen]) {
        if (!currentBad.has(key)) seen.delete(key)
      }
      // Newly broken (not yet notified) → coalesced count.
      let newly = 0
      for (const key of currentBad) {
        if (!seen.has(key)) {
          seen.add(key)
          newly++
        }
      }
      if (newly > 0) fireToast(category, newly)
    }

    // ── Servers: 10s HTTP probe ─────────────────────────────────────────
    createEffect(() => {
      const list = server.list
      let dead = false
      let inFlight = false
      const refresh = async () => {
        if (inFlight) return
        inFlight = true
        try {
          const results: Record<string, ServerHealth | undefined> = {}
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
          setServerHealth(reconcile(results))
          const bad = new Set<string>()
          for (const conn of list) {
            const key = ServerConnection.key(conn)
            if (results[key]?.healthy === false) bad.add(key)
          }
          reconcileCategory("server", bad)
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

    // Active project's child store on the global sync. Recomputes when the
    // user switches projects; switching also resets the per-category
    // "already notified" sets so the new project starts from a clean state.
    const childStore = createMemo(() => {
      const dir = directory()
      if (!dir) return undefined
      const [store] = globalSync.child(dir, { bootstrap: false })
      return store
    })

    createEffect(
      on(directory, () => {
        notified.mcp.clear()
        notified.lsp.clear()
      }),
    )

    // ── MCP: react to status field in the per-directory child store ─────
    createEffect(
      on(
        () => {
          const store = childStore()
          return store ? Object.entries(store.mcp ?? {}) : []
        },
        (entries) => {
          const bad = new Set<string>()
          for (const [name, m] of entries) {
            const status = m?.status
            if (status === "failed" || status === "needs_auth" || status === "needs_client_registration") {
              bad.add(name)
            }
          }
          reconcileCategory("mcp", bad)
        },
      ),
    )

    // ── LSP: same, on the child store's lsp array ───────────────────────
    createEffect(
      on(
        () => {
          const store = childStore()
          return store?.lsp ?? []
        },
        (items) => {
          const bad = new Set<string>()
          for (const item of items) {
            if (item.status === "error") bad.add(item.id || item.name || "")
          }
          reconcileCategory("lsp", bad)
        },
      ),
    )

    return {
      serverHealth,
      directory,
    }
  },
})
