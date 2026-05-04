import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { isSessionRunning } from "@/pages/session/session-running-state"
import { findRunningQuestionFallbackSession } from "./question-fallback"
import { createQuestionRecoveryClock } from "./question-recovery-clock"
import { resolveQuestionRecoverySnapshot } from "./question-recovery-snapshot"
import { createQuestionRefetchRunner } from "./question-refetch-runner"
import { refetchPendingQuestionsForSession } from "./question-reconcile"
import { sessionPermissionRequest, sessionQuestionRequest } from "./request-tree"

export function createSessionBlockers(input: {
  sessionID: () => string | undefined
  halt?: (sessionID: string) => Promise<unknown>
}) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const permission = usePermission()
  const activeSessionID = input.sessionID

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
  })

  const questionRequest = createMemo(() => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, activeSessionID())
  })

  const questionFallbackSessionID = createMemo(() => {
    const sessionID = activeSessionID()
    return findRunningQuestionFallbackSession({
      sessionID,
      // Pass the per-session entries so fallback can match by (messageID,
      // callID) — not the tree-walked sessionQuestionRequest result, which
      // would mask local multi-pending loss. See #419.
      syncQuestions: sessionID ? (sync.data.question[sessionID] ?? []) : [],
      messages: sessionID ? sync.data.message[sessionID] : undefined,
      partsByMessageID: sync.data.part,
    })
  })

  let alive = true
  const questionRefetch = createQuestionRefetchRunner({
    getFallbackSessionID: questionFallbackSessionID,
    refetch: (sessionID) =>
      refetchPendingQuestionsForSession({
        sessionID,
        shouldContinue: () => alive && questionFallbackSessionID() === sessionID,
        list: () => sdk.client.question.list().then((result) => result.data ?? []),
        apply(sid, questions) {
          batch(() => {
            sync.set("question", sid, reconcile(questions, { key: "id" }))
          })
        },
      }),
  })
  onCleanup(() => {
    alive = false
    questionRefetch.dispose()
  })

  createEffect(
    on(questionFallbackSessionID, (sessionID) => {
      questionRefetch.start(sessionID)
    }),
  )

  // Auto-heal: detect hidden question blockers (running question part but no
  // sync coverage) and halt the stuck session after a short delay. The
  // composer keeps `recoveringQuestion()` so existing UI/refetch behavior is
  // unchanged; the clock fires only as a last-resort cleanup.
  const recoverySnapshot = createMemo(() => {
    const sessionID = activeSessionID()
    return resolveQuestionRecoverySnapshot({
      sessionID,
      sessionTreeQuestionRequest: questionRequest(),
      activeSessionSyncQuestions: sessionID ? (sync.data.question[sessionID] ?? []) : [],
      activeSessionMessages: sessionID ? sync.data.message[sessionID] : undefined,
      partsByMessageID: sync.data.part,
    })
  })

  if (input.halt) {
    const halt = input.halt
    const clock = createQuestionRecoveryClock({
      snapshot: recoverySnapshot,
      activeSessionID,
      activeDirectory: () => sdk.directory,
      halt,
      reverify: async (sessionID, ctx) => {
        const localGuards = () => {
          // Guard 1: snapshot still missingRunning for this session.
          if (recoverySnapshot().kind !== "missingRunning") return false
          // Guard 2: active session unchanged (directory pin via armedDirectory).
          if (activeSessionID() !== sessionID) return false
          if (sdk.directory !== ctx.armedDirectory) return false
          // Guard 3: session still busy.
          if (
            !isSessionRunning(
              sync.data.session_status[sessionID],
              sync.data.message[sessionID],
            )
          )
            return false
          return true
        }
        if (!localGuards()) return { proceed: false }
        // Guard 4: server confirms the running question part is still
        // uncovered (reuses fallback semantics so auto-heal and recovery
        // dock never disagree). A transient list() failure asks the
        // clock to re-arm once instead of halting blindly or dead-ending
        // a sticky stuck session.
        let filtered: Awaited<ReturnType<typeof sdk.client.question.list>>["data"]
        try {
          const result = await sdk.client.question.list()
          filtered = (result.data ?? []).filter((q) => q.sessionID === sessionID)
        } catch (err) {
          console.warn("question-recovery: question.list() failed", { sessionID, err })
          // Ask the clock for one bounded follow-up attempt (see
          // ReverifyOutcome in question-recovery-clock.ts). A second
          // consecutive failure waits for a fresh snapshot edge instead of
          // looping the server.
          return { proceed: false, retry: true }
        }
        // Re-check the local guards after the await — state may have moved.
        if (!localGuards()) return { proceed: false }
        const stillUncovered = findRunningQuestionFallbackSession({
          sessionID,
          syncQuestions: filtered,
          messages: sync.data.message[sessionID],
          partsByMessageID: sync.data.part,
        })
        if (stillUncovered === sessionID) return { proceed: true }
        // Server already covers it — write back so UI stops looking stuck.
        batch(() => {
          sync.set("question", sessionID, reconcile(filtered, { key: "id" }))
        })
        return { proceed: false }
      },
    })
    // clock self-cleans via its own onCleanup; the binding above is kept
    // only so `clock` is referenced (the side-effect of construction is
    // what we want).
    void clock
  }

  const permissionRequest = createMemo(() => {
    return sessionPermissionRequest(sync.data.session, sync.data.permission, activeSessionID(), (item) => {
      return !permission.autoResponds(item, sdk.directory)
    })
  })

  const blocked = createMemo(() => {
    const id = activeSessionID()
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  return {
    blocked,
    recoveringQuestion: () => !!questionFallbackSessionID(),
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
  }
}
