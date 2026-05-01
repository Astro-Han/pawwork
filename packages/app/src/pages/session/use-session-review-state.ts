import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { deriveArtifactFiles, type SessionArtifactFile } from "@/pages/session/files-tab-state"
import {
  coerceReviewChangeMode,
  isVcsReviewMode,
  nextReviewModeForSessionChange,
  reviewChangeOptions,
  reviewDiffsForMode,
  type ReviewChangeMode,
  type VcsReviewMode,
} from "@/pages/session/review-change-mode"
import { diffs as list } from "@/utils/diffs"

type SessionReviewDiff = SnapshotFileDiff | VcsFileDiff

export function deriveReviewArtifactFiles(input: {
  directory: string
  sessionID: string | undefined
  history: { sessionID: string; artifacts: SessionArtifactFile[] } | undefined
  turnDiffs: Array<{ file: string; status?: string }>
}) {
  const history = input.history
  if (history && history.sessionID === input.sessionID && history.artifacts.length > 0) {
    return deriveArtifactFiles(input.directory, history.artifacts)
  }

  return deriveArtifactFiles(
    input.directory,
    input.turnDiffs.flatMap((diff) => {
      if (diff.status !== "added" && diff.status !== "modified") return []
      return [{ file: diff.file, kind: diff.status as "added" | "modified" }]
    }),
  )
}

export function createSessionReviewState(input: {
  directory: string
  sessionKey: () => string
  sessionID: () => string | undefined
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  wantsReview: () => boolean
  turnDiffs: () => SessionReviewDiff[]
}) {
  const [changes, setChanges] = createSignal<ReviewChangeMode>("turn")
  const [vcs, setVcs] = createStore<{
    diff: Record<VcsReviewMode, SessionReviewDiff[]>
    ready: Record<VcsReviewMode, boolean>
  }>({
    diff: {
      unstaged: [],
      staged: [],
      branch: [],
    },
    ready: {
      unstaged: false,
      staged: false,
      branch: false,
    },
  })

  const vcsTask = new Map<VcsReviewMode, Promise<void>>()
  const vcsRun = new Map<VcsReviewMode, number>()

  const bumpVcs = (mode: VcsReviewMode) => {
    const next = (vcsRun.get(mode) ?? 0) + 1
    vcsRun.set(mode, next)
    return next
  }

  const resetVcs = (mode?: VcsReviewMode) => {
    const modes = mode ? [mode] : (["unstaged", "staged", "branch"] as const)
    modes.forEach((item) => {
      bumpVcs(item)
      vcsTask.delete(item)
      setVcs("diff", item, [])
      setVcs("ready", item, false)
    })
  }

  const loadVcs = (mode: VcsReviewMode, force = false) => {
    if (input.sync.project?.vcs !== "git") return Promise.resolve()
    if (!force && vcs.ready[mode]) return Promise.resolve()

    if (force) {
      if (vcsTask.has(mode)) bumpVcs(mode)
      vcsTask.delete(mode)
      setVcs("ready", mode, false)
    }

    const current = vcsTask.get(mode)
    if (current) return current
    const run = bumpVcs(mode)

    const task = input.sdk.client.vcs
      .diff({ mode })
      .then((result) => {
        if (vcsRun.get(mode) !== run) return
        setVcs("diff", mode, list(result.data))
        setVcs("ready", mode, true)
      })
      .catch((error: unknown) => {
        if (vcsRun.get(mode) !== run) return
        console.debug("[session-review] failed to load vcs diff", { mode, error })
        setVcs("diff", mode, [])
        setVcs("ready", mode, true)
      })
      .finally(() => {
        if (vcsTask.get(mode) === task) vcsTask.delete(mode)
      })

    vcsTask.set(mode, task)
    return task
  }

  const changesOptions = createMemo<ReviewChangeMode[]>(() =>
    reviewChangeOptions({ isGit: input.sync.project?.vcs === "git" }),
  )
  const vcsMode = createMemo<VcsReviewMode | undefined>(() => {
    const value = changes()
    if (isVcsReviewMode(value)) return value
  })
  const reviewDiffs = createMemo(() =>
    list(
      reviewDiffsForMode(changes(), {
        turn: input.turnDiffs(),
        vcs: vcs.diff,
      }),
    ),
  )
  const reviewCount = createMemo(() => reviewDiffs().length)
  const hasReview = createMemo(() => reviewCount() > 0)
  const reviewReady = createMemo(() => {
    const value = changes()
    return isVcsReviewMode(value) ? vcs.ready[value] : true
  })

  const [artifactHistory, { refetch: refetchArtifactHistory }] = createResource(
    input.sessionID,
    async (sessionID) => ({
      sessionID,
      artifacts: await input.sdk.client.session
        .artifacts({ sessionID })
        .then((res) => res.data ?? [])
        .catch(() => []),
    }),
    { initialValue: { sessionID: "", artifacts: [] as SessionArtifactFile[] } },
  )
  let artifactHistoryFrame: number | undefined
  let artifactHistoryPending = false
  const queueArtifactHistoryRefetch = () => {
    artifactHistoryPending = true
    if (artifactHistoryFrame !== undefined) return
    artifactHistoryFrame = requestAnimationFrame(() => {
      artifactHistoryFrame = undefined
      if (!artifactHistoryPending) return
      artifactHistoryPending = false
      void refetchArtifactHistory()
    })
  }
  onCleanup(() => {
    if (artifactHistoryFrame !== undefined) cancelAnimationFrame(artifactHistoryFrame)
  })
  const artifactFiles = createMemo(() =>
    deriveReviewArtifactFiles({
      directory: input.directory,
      sessionID: input.sessionID(),
      history: artifactHistory.latest,
      turnDiffs: input.turnDiffs(),
    }),
  )

  createEffect(
    on(
      input.sessionKey,
      () => {
        setChanges(nextReviewModeForSessionChange())
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const options = changesOptions()
    const current = changes()
    const next = coerceReviewChangeMode(current, options)
    if (next !== current) setChanges(next)
  })

  createEffect(() => {
    const mode = vcsMode()
    if (!mode) return
    if (!input.wantsReview()) return
    void loadVcs(mode)
  })

  createEffect(() => {
    const id = input.sessionID()
    if (!id) return
    input.turnDiffs()
    queueArtifactHistoryRefetch()
  })

  createEffect(() => {
    const id = input.sessionID()
    if (!id) return
    if (input.sync.data.session_diff[id] === undefined) return
    queueArtifactHistoryRefetch()
  })

  return {
    changes,
    setChanges,
    changesOptions,
    vcsMode,
    reviewDiffs,
    reviewCount,
    hasReview,
    reviewReady,
    artifactFiles,
    resetVcs,
    loadVcs,
  }
}
