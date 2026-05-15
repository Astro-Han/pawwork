import { createMemo, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import type { Part } from "@opencode-ai/sdk/v2"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { SessionStatusSummary } from "./session-status-summary"
import { SessionStatusConnections } from "./session-status-connections"

export function SessionStatusPanel(props: { shown: Accessor<boolean> }) {
  const params = useParams()
  const globalSync = useGlobalSync()
  const sync = useSync()

  const parts = createMemo<Part[]>(() => {
    if (!params.id) return []
    const messages = sync.data.message[params.id] ?? []
    return messages.flatMap((message) => sync.data.part[message.id] ?? [])
  })
  const backend = createMemo(() => (params.id ? globalSync.data.session_todo[params.id] : undefined))
  const backendClearActiveParts = createMemo(() =>
    params.id ? globalSync.data.session_todo_clear[params.id] === true : false,
  )

  return (
    <div class="h-full min-h-0 overflow-y-auto">
      <SessionStatusSummary backend={backend} backendClearActiveParts={backendClearActiveParts} parts={parts} />
      <SessionStatusConnections shown={props.shown} />
    </div>
  )
}
