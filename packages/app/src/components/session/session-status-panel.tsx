import { createMemo, onCleanup, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import type { Part } from "@opencode-ai/sdk/v2"
import { useGlobalSync } from "@/context/global-sync"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { FilesTabEntry } from "@/pages/session/files-tab-state"
import { aggregateFiles } from "@/pages/session/session-aggregate-files"
import { isFileWatcherVcsRefreshEvent } from "@/pages/session/use-session-vcs-refresh"
import { SessionStatusSummary } from "./session-status-summary"

export function SessionStatusPanel(props: {
  shown: Accessor<boolean>
  artifactFiles?: Accessor<FilesTabEntry[]>
  onNavigateReview?: () => void
}) {
  const params = useParams()
  const globalSync = useGlobalSync()
  const sdk = useSDK()
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

  const vcs = () => sync.data.vcs

  const stopVcsRefresh = sdk.event.on("file.watcher.updated", (evt) => {
    if (!isFileWatcherVcsRefreshEvent(evt)) return
    void sdk.client.vcs.get().then((res) => {
      if (res.data) sync.set("vcs", res.data)
    })
  })
  onCleanup(stopVcsRefresh)

  const activeWorktree = createMemo(() => {
    if (!params.id) return undefined
    const session = sync.session.get(params.id)
    const exec = session?.executionContext
    if (!exec) return undefined
    return exec.activeWorktree
  })

  const diffStats = createMemo(() => {
    if (!params.id) return { additions: 0, deletions: 0 }
    const files = aggregateFiles(sync.data.turn_change_aggregate[params.id])
    let additions = 0
    let deletions = 0
    for (const file of files) {
      additions += file.additions
      deletions += file.deletions
    }
    return { additions, deletions }
  })

  return (
    <div class="h-full min-h-0 overflow-y-auto">
      <SessionStatusSummary
        canonical={canonical}
        isAuthoritativelyInvalidated={isAuthoritativelyInvalidated}
        isPending={isPending}
        parts={parts}
        vcs={vcs}
        activeWorktree={activeWorktree}
        diffStats={diffStats}
        artifactFiles={props.artifactFiles}
        onNavigateReview={props.onNavigateReview}
      />
    </div>
  )
}
