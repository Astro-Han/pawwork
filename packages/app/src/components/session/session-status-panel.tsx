import { createMemo, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import type { Part } from "@opencode-ai/sdk/v2"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { SessionStatusSummary } from "./session-status-summary"

// `shown` is kept on the props contract: callers still gate this tab and the
// summary stays a cheap reactive read, so there is nothing here to pause when
// the tab is hidden. Connection health moved to Settings.Integrations +
// the global ConnectionHealth toast monitor (closes #862).
export function SessionStatusPanel(_props: { shown: Accessor<boolean> }) {
  const params = useParams()
  const globalSync = useGlobalSync()
  const sync = useSync()

  const parts = createMemo<Part[]>(() => {
    if (!params.id) return []
    const messages = sync.data.message[params.id] ?? []
    return messages.flatMap((message) => sync.data.part[message.id] ?? [])
  })
  const canonical = createMemo(() => (params.id ? globalSync.data.session_todo[params.id] : undefined))
  const isAuthoritativelyInvalidated = createMemo(() =>
    params.id ? globalSync.todoHydrate.isAuthoritativelyInvalidated(params.id) : false,
  )
  const isPending = createMemo(() =>
    params.id && sync.directory ? globalSync.todoHydrate.isPending(sync.directory, params.id) : false,
  )

  return (
    <div class="h-full min-h-0 overflow-y-auto">
      <SessionStatusSummary
        canonical={canonical}
        isAuthoritativelyInvalidated={isAuthoritativelyInvalidated}
        isPending={isPending}
        parts={parts}
      />
    </div>
  )
}
