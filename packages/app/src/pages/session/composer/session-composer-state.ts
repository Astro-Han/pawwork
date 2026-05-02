import { batch, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { composerDriver, composerEnabled, composerEvent, composerStateProbe } from "@/testing/session-composer"
import { selectSessionTodos } from "@/pages/session/session-todos"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const TODO_DOCK_COMPLETING_DELAY_MS = 3000

const todoTerminal = (todo: Todo) => todo.status === "completed" || todo.status === "cancelled"

const todoSignature = (todos: Todo[]) => todos.map((todo) => `${todo.status}:${todo.content}`).join("\u0000")

export function createSessionComposerState(input: {
  sessionID: () => string | undefined
  fallbackSessionID?: () => string | undefined
}) {
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const permission = usePermission()
  const activeSessionID = input.sessionID

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, activeSessionID())
  })

  // Fallback: if a running "question" tool part exists in message parts but no
  // question request was received (e.g. the question.asked SSE event was lost),
  // re-fetch the pending question list from the backend.
  let questionRefetchInflight = false
  createEffect(
    on(
      () => {
        const sessionID = activeSessionID()
        if (!sessionID) return undefined
        if (questionRequest()) return undefined
        const messages = sync.data.message[sessionID]
        if (!messages?.length) return undefined
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
          const parts = sync.data.part[messages[i].id]
          if (!parts) continue
          for (const p of parts) {
            if (p.type === "tool" && p.tool === "question" && p.state.status === "running") {
              return sessionID
            }
          }
        }
        return undefined
      },
      (sessionID) => {
        if (!sessionID || questionRefetchInflight) return
        questionRefetchInflight = true
        sdk.client.question
          .list()
          .then((result) => {
            const questions = (result.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID)
            if (questions.length === 0) return
            const grouped = new Map<string, QuestionRequest[]>()
            for (const q of questions) {
              const list = grouped.get(q.sessionID)
              if (list) list.push(q)
              else grouped.set(q.sessionID, [q])
            }
            batch(() => {
              for (const [sid, qs] of grouped) {
                sync.set(
                  "question",
                  sid,
                  reconcile(
                    qs.sort((a, b) => (a.id < b.id ? -1 : 1)),
                    { key: "id" },
                  ),
                )
              }
            })
          })
          .catch(() => {})
          .finally(() => {
            questionRefetchInflight = false
          })
      },
    ),
  )

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync.data.session, sync.data.permission, activeSessionID(), (item) => {
      return !permission.autoResponds(item, sdk.directory)
    })
  })

  const blocked = createMemo(() => {
    const id = activeSessionID()
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const [test, setTest] = createStore({
    on: false,
    todos: undefined as Todo[] | undefined,
  })

  const pull = () => {
    const id = activeSessionID()
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
    createEffect(on(activeSessionID, pull, { defer: true }))

    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID?: string }>).detail
      if (detail?.sessionID !== activeSessionID()) return
      pull()
    }

    makeEventListener(window, composerEvent, onEvent)
  })

  const todos = createMemo((): Todo[] => {
    if (test.on && test.todos !== undefined) return test.todos
    const id = activeSessionID()
    if (!id) return []
    // Todo data follows the backend list. Dock visibility is derived below so terminal todos can remain stored after the dock hides.
    const messages = sync.data.message[id] ?? []
    const parts = messages.flatMap((message) => sync.data.part[message.id] ?? [])
    const fallbackID = input.fallbackSessionID?.()
    const fallbackMessages = fallbackID && fallbackID !== id ? (sync.data.message[fallbackID] ?? []) : []
    const fallbackParts = fallbackMessages.flatMap((message) => sync.data.part[message.id] ?? [])
    return selectSessionTodos({
      backend: globalSync.data.session_todo[id],
      parts,
      fallback: { backend: fallbackID ? globalSync.data.session_todo[fallbackID] : undefined, parts: fallbackParts },
    })
  })

  const allDone = createMemo(() => {
    const list = todos()
    return list.length > 0 && list.every(todoTerminal)
  })

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    dock: todos().length > 0,
    opening: false,
    completing: allDone(),
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
  let hideTimeout: number | undefined
  let lastTodoSessionID: string | undefined
  const sessionsWithActiveTodos = new Set<string>()

  const clearHideTimeout = () => {
    if (hideTimeout === undefined) return
    window.clearTimeout(hideTimeout)
    hideTimeout = undefined
  }

  createEffect(
    on(
      () => ({
        allDone: allDone(),
        count: todos().length,
        sessionID: activeSessionID(),
        signature: todoSignature(todos()),
      }),
      ({ allDone: done, count, sessionID: expectedSessionID, signature }) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined
        const sessionChanged = expectedSessionID !== lastTodoSessionID
        lastTodoSessionID = expectedSessionID

        if (count === 0) {
          if (expectedSessionID) sessionsWithActiveTodos.delete(expectedSessionID)
          clearHideTimeout()
          setStore({ dock: false, opening: false, completing: false })
          return
        }

        if (done) {
          if (sessionChanged || !expectedSessionID || !sessionsWithActiveTodos.has(expectedSessionID)) {
            clearHideTimeout()
            setStore({ dock: false, opening: false, completing: false })
            return
          }

          setStore({ dock: true, opening: false, completing: true })
          clearHideTimeout()
          hideTimeout = window.setTimeout(() => {
            if (activeSessionID() === expectedSessionID && allDone() && todoSignature(todos()) === signature) {
              setStore({ dock: false, opening: false, completing: false })
            }
            hideTimeout = undefined
          }, TODO_DOCK_COMPLETING_DELAY_MS)
          return
        }

        if (expectedSessionID) sessionsWithActiveTodos.add(expectedSessionID)
        clearHideTimeout()
        setStore("completing", false)

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

  createEffect(() => {
    if (!composerEnabled()) return
    const probe = composerStateProbe(activeSessionID())
    probe.set({
      dock: store.dock,
      opening: store.opening,
      completing: store.completing,
      count: todos().length,
      states: todos().map((todo) => todo.status),
    })
    onCleanup(() => probe.drop())
  })

  onCleanup(() => {
    if (raf) cancelAnimationFrame(raf)
    clearHideTimeout()
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
