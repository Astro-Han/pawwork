import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { findRunningQuestionFallbackSession } from "./question-fallback"
import { createQuestionRefetchRunner } from "./question-refetch-runner"
import { refetchPendingQuestionsForSession } from "./question-reconcile"
import { sessionPermissionRequest, sessionQuestionRequest } from "./request-tree"

export function createSessionBlockers(input: { sessionID: () => string | undefined }) {
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
      hasQuestionRequest: !!questionRequest(),
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
