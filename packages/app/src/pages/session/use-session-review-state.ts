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
import { sameExecutionScope, shouldApplyExecutionResult, vcsTaskKey, type ExecutionScope } from "./execution-scope"

type SessionReviewDiff = SnapshotFileDiff | VcsFileDiff

export function deriveReviewArtifactFiles(input: {
  currentScope: ExecutionScope
  sessionID: string | undefined
  history: { scope: ExecutionScope; sessionID: string; artifacts: SessionArtifactFile[] } | undefined
  turnDiffs?: Array<{ file: string; status?: string }>
}) {
  const history = input.history
  if (
    history &&
    history.sessionID === input.sessionID &&
    shouldApplyExecutionResult({ requested: history.scope, current: input.currentScope }) &&
    history.artifacts.length > 0
  ) {
    return deriveArtifactFiles(input.currentScope.directory, history.artifacts)
  }

  const turnDiffs = input.turnDiffs ?? []
  return deriveArtifactFiles(
    input.currentScope.directory,
    turnDiffs.flatMap((diff) => {
      if (diff.status !== "added" && diff.status !== "modified") return []
      return [{ file: diff.file, kind: diff.status as "added" | "modified" }]
    }),
  )
}

export function createSessionReviewState(input: {
  directory: () => string
  executionScope: () => ExecutionScope
  sessionKey: () => string
  sessionID: () => string | undefined
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  wantsReview: () => boolean
  turnDiffs: () => SessionReviewDiff[]
  artifactDiffs?: () => SessionReviewDiff[]
}) {
  const [changes, setChanges] = createSignal<ReviewChangeMode>("turn")
  const [vcs, setVcs] = createStore<{
    diff: Record<VcsReviewMode, SessionReviewDiff[]>
    ready: Record<VcsReviewMode, boolean>
    scope: Record<VcsReviewMode, ExecutionScope | undefined>
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
    scope: {
      unstaged: undefined,
      staged: undefined,
      branch: undefined,
    },
  })

  const vcsTask = new Map<string, Promise<void>>()
  const vcsRun = new Map<string, number>()

  const bumpVcs = (scope: ExecutionScope, mode: VcsReviewMode) => {
    const key = vcsTaskKey(scope, mode)
    const next = (vcsRun.get(key) ?? 0) + 1
    vcsRun.set(key, next)
    return next
  }

  const resetVcs = (mode?: VcsReviewMode) => {
    const scope = input.executionScope()
    const modes = mode ? [mode] : (["unstaged", "staged", "branch"] as const)
    modes.forEach((item) => {
      const key = vcsTaskKey(scope, item)
      bumpVcs(scope, item)
      vcsTask.delete(key)
      setVcs("diff", item, [])
      setVcs("ready", item, false)
      setVcs("scope", item, undefined)
    })
  }

  const loadVcs = (mode: VcsReviewMode, force = false) => {
    if (input.sync.project?.vcs !== "git") return Promise.resolve()
    const requestedScope = input.executionScope()
    if (!force && vcs.ready[mode] && sameExecutionScope(vcs.scope[mode], requestedScope)) return Promise.resolve()
    const key = vcsTaskKey(requestedScope, mode)

    if (force) {
      if (vcsTask.has(key)) bumpVcs(requestedScope, mode)
      vcsTask.delete(key)
      setVcs("ready", mode, false)
      setVcs("scope", mode, undefined)
    } else if (!sameExecutionScope(vcs.scope[mode], requestedScope)) {
      setVcs("diff", mode, [])
      setVcs("ready", mode, false)
      setVcs("scope", mode, undefined)
    }

    const current = vcsTask.get(key)
    if (current) return current
    const run = bumpVcs(requestedScope, mode)
    const client = input.sdk.createClient({ directory: requestedScope.directory, throwOnError: true })

    const task = client.vcs
      .diff({ mode })
      .then((result) => {
        if (!shouldApplyExecutionResult({ requested: requestedScope, current: input.executionScope() })) return
        if (vcsRun.get(key) !== run) return
        setVcs("diff", mode, list(result.data))
        setVcs("scope", mode, requestedScope)
        setVcs("ready", mode, true)
      })
      .catch((error: unknown) => {
        if (!shouldApplyExecutionResult({ requested: requestedScope, current: input.executionScope() })) return
        if (vcsRun.get(key) !== run) return
        console.debug("[session-review] failed to load vcs diff", { mode, error })
        setVcs("diff", mode, [])
        setVcs("scope", mode, requestedScope)
        setVcs("ready", mode, true)
      })
      .finally(() => {
        if (vcsTask.get(key) === task) vcsTask.delete(key)
      })

    vcsTask.set(key, task)
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
    return isVcsReviewMode(value) ? vcs.ready[value] && sameExecutionScope(vcs.scope[value], input.executionScope()) : true
  })

  const [artifactHistory, { refetch: refetchArtifactHistory }] = createResource(
    () => {
      const sessionID = input.sessionID()
      if (!sessionID) return
      const scope = input.executionScope()
      return { scope, sessionID }
    },
    async ({ scope, sessionID }) => ({
      scope,
      sessionID,
      artifacts: await input.sdk
        .createClient({ directory: scope.directory, throwOnError: true })
        .session
        .artifacts({ sessionID })
        .then((res) => res.data ?? [])
        .catch(() => []),
    }),
    {
      initialValue: {
        scope: { serverKey: "", directory: "", epoch: -1 },
        sessionID: "",
        artifacts: [] as SessionArtifactFile[],
      },
    },
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
      currentScope: input.executionScope(),
      sessionID: input.sessionID(),
      history: artifactHistory.latest,
      turnDiffs: input.artifactDiffs?.() ?? input.turnDiffs(),
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
    input.artifactDiffs?.() ?? input.turnDiffs()
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
