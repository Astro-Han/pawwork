import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest } from "./request-tree"
import {
  type DockQuestionRequest,
  findDescendantExternalResultQuestion,
} from "./running-external-result-question"

export type { DockQuestionRequest }

export function createSessionBlockers(input: {
  sessionID: () => string | undefined
}) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const permission = usePermission()
  const activeSessionID = input.sessionID

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
  })

  const questionRequest = createMemo<DockQuestionRequest | undefined>(() => {
    const sid = activeSessionID()
    if (!sid) return undefined
    // Walk the session tree so a parent session page surfaces a question
    // asked by a child agent. Mirrors sessionPermissionRequest, which has
    // walked the tree since #419.
    return findDescendantExternalResultQuestion({
      sessions: sync.data.session,
      rootSessionID: sid,
      pendingQuestions: sync.data.external_result_question,
      messages: sync.data.message,
      partsByMessageID: sync.data.part,
    })
  })

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
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
  }
}
