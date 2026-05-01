import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createStore } from "solid-js/store"
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

export function deriveReviewArtifactFiles(input: {
  directory: string
  sessionID: string | undefined
  history: { sessionID: string; artifacts: SessionArtifactFile[] } | undefined
  turnDiffs: Array<{ file: string; status: string }>
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
  sync: any
  sdk: any
  wantsReview: () => boolean
  turnDiffs: () => any[]
}) {
  const [store, setStore] = createStore({
    changes: "turn" as ReviewChangeMode,
  })
  const [vcs, setVcs] = createStore<{
    diff: Record<VcsReviewMode, VcsFileDiff[]>
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
      .then((result: any) => {
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
    if (isVcsReviewMode(store.changes)) return store.changes
  })
  const reviewDiffs = createMemo(() =>
    list(
      reviewDiffsForMode(store.changes, {
        turn: input.turnDiffs(),
        vcs: vcs.diff,
      }),
    ),
  )
  const reviewCount = createMemo(() => reviewDiffs().length)
  const hasReview = createMemo(() => reviewCount() > 0)
  const reviewReady = createMemo(() => (isVcsReviewMode(store.changes) ? vcs.ready[store.changes] : true))

  const [artifactHistory, { refetch: refetchArtifactHistory }] = createResource(
    input.sessionID,
    async (sessionID) => ({
      sessionID,
      artifacts: await input.sdk.client.session
        .artifacts({ sessionID })
        .then((res: any) => res.data ?? [])
        .catch(() => []),
    }),
    { initialValue: { sessionID: "", artifacts: [] as SessionArtifactFile[] } },
  )
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
        setStore("changes", nextReviewModeForSessionChange())
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const options = changesOptions()
    const next = coerceReviewChangeMode(store.changes, options)
    if (next !== store.changes) setStore("changes", next)
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
    void refetchArtifactHistory()
  })

  createEffect(() => {
    const id = input.sessionID()
    if (!id) return
    if (input.sync.data.session_diff[id] === undefined) return
    void refetchArtifactHistory()
  })

  return {
    changes: () => store.changes,
    setChanges: (value: ReviewChangeMode) => setStore("changes", value),
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
