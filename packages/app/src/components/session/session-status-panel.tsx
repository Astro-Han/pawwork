import { createMemo, createResource, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import type { Part } from "@opencode-ai/sdk/v2"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { canOpenLocalPath, usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { normalizeArtifactPathKey, type FilesTabEntry } from "@/pages/session/files-tab-state"
import { aggregateFiles } from "@/pages/session/session-aggregate-files"
import { SessionStatusSummary } from "./session-status-summary"

export function SessionStatusPanel(props: {
  shown: Accessor<boolean>
  artifactFiles?: Accessor<FilesTabEntry[]>
  onNavigateReview?: () => void
}) {
  const params = useParams()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()

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

  const vcs = createMemo(() => sync.data.vcs)

  const activeWorktree = createMemo(() => {
    if (!params.id) return undefined
    const session = sync.session.get(params.id)
    const exec = session?.executionContext
    if (!exec) return undefined
    return exec.activeWorktree
  })

  const aggregatedFiles = createMemo(() =>
    params.id ? aggregateFiles(sync.data.turn_change_aggregate[params.id]) : [],
  )

  const diffStats = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const file of aggregatedFiles()) {
      additions += file.additions
      deletions += file.deletions
    }
    return { additions, deletions }
  })

  const diffsByPath = createMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>()
    for (const file of aggregatedFiles()) {
      map.set(normalizeArtifactPathKey(file.file), { additions: file.additions, deletions: file.deletions })
    }
    return map
  })

  // Stat artifact files so per-row open/reveal buttons can disable themselves
  // when the file is gone (deleted between the agent writing it and the user
  // clicking). Mirrors the old Files-tab stat resource. On web (no statPaths
  // capability) every file is treated as existing — clicking still no-ops
  // because canOpenLocalPath returns false there.
  const artifactPaths = createMemo(() => (props.artifactFiles?.() ?? []).map((file) => file.path))
  const [artifactStats] = createResource(artifactPaths, async (paths) => {
    if (paths.length === 0) return {} as Record<string, { size: number; exists: boolean }>
    if (!platform.statPaths) {
      return Object.fromEntries(paths.map((path) => [path, { size: 0, exists: true }]))
    }
    return platform.statPaths(paths)
  })
  // While the resource is pending the row should still feel actionable, so
  // assume the file exists until we know otherwise. This matches how the row
  // first renders right after a turn — the file did exist when the agent wrote
  // it, and the click is no-op-safe even if stat later reports missing.
  const artifactExists = (path: string) => artifactStats()?.[path]?.exists ?? true

  const reportFailure = (error: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error),
    })
  }

  const canOpenWorktreeDirectory = (directory: string): boolean =>
    !!(canOpenLocalPath(platform) && server.isLocal() && platform.openPath && directory)
  const openWorktreeDirectory = (directory: string) => {
    if (!canOpenWorktreeDirectory(directory) || !platform.openPath) return
    void platform.openPath(directory).catch(reportFailure)
  }

  const canOpenArtifactFile = (path: string): boolean =>
    !!(canOpenLocalPath(platform) && server.isLocal() && platform.openPath && artifactExists(path))
  const openArtifactFile = (path: string) => {
    if (!canOpenArtifactFile(path) || !platform.openPath) return
    void platform.openPath(path).catch(reportFailure)
  }

  const canRevealArtifactFile = (path: string): boolean =>
    !!(canOpenLocalPath(platform) && server.isLocal() && platform.showItemInFolder && artifactExists(path))
  const revealArtifactFile = (path: string) => {
    if (!canRevealArtifactFile(path) || !platform.showItemInFolder) return
    void platform.showItemInFolder(path).catch(reportFailure)
  }

  // openLink is the only mandatory Platform method, so there is no capability
  // gate. It may still throw synchronously (e.g. an invalid scheme) — catch
  // and surface the same failure toast as the file/directory openers.
  const openSourceLink = (url: string) => {
    try {
      platform.openLink(url)
    } catch (error) {
      reportFailure(error)
    }
  }

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
        diffsByPath={diffsByPath}
        canOpenWorktreeDirectory={canOpenWorktreeDirectory}
        canOpenArtifactFile={canOpenArtifactFile}
        canRevealArtifactFile={canRevealArtifactFile}
        onNavigateReview={props.onNavigateReview}
        onOpenWorktreeDirectory={openWorktreeDirectory}
        onOpenArtifactFile={openArtifactFile}
        onRevealArtifactFile={revealArtifactFile}
        onOpenSourceLink={openSourceLink}
      />
    </div>
  )
}
