import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { composerDriver, composerEnabled, composerEvent } from "@/testing/session-composer"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

export function createSessionComposerState() {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, params.id)
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync.data.session, sync.data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk.directory)
    })
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const [test, setTest] = createStore({
    on: false,
    todos: undefined as Todo[] | undefined,
  })

  const pull = () => {
    const id = params.id
    if (!id) {
      setTest({ on: false, todos: undefined })
      return
    }

    const next = composerDriver(id)
    if (!next) {
      setTest({ on: false, todos: undefined })
      return
    }

    setTest({
      on: true,
      todos: next.todos?.map((todo) => ({ ...todo })),
    })
  }

  onMount(() => {
    if (!composerEnabled()) return

    pull()
    createEffect(on(() => params.id, pull, { defer: true }))

    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID?: string }>).detail
      if (detail?.sessionID !== params.id) return
      pull()
    }

    makeEventListener(window, composerEvent, onEvent)
  })

  const todos = createMemo((): Todo[] => {
    if (test.on && test.todos !== undefined) return test.todos
    const id = params.id
    if (!id) return []
    // Todo visibility follows the backend todo list; keep the dock until the list is explicitly empty.
    return globalSync.data.session_todo[id] ?? []
  })

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    dock: todos().length > 0,
    opening: false,
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

  let raf: number | undefined

  createEffect(
    on(
      () => todos().length,
      (count) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        if (count === 0) {
          setStore({ dock: false, opening: false })
          return
        }

        const hidden = !store.dock
        setStore("dock", true)
        if (hidden) {
          setStore("opening", true)
          raf = requestAnimationFrame(() => {
            setStore("opening", false)
            raf = undefined
          })
          return
        }
        setStore("opening", false)
      },
    ),
  )

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    dock: () => store.dock,
    opening: () => store.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
