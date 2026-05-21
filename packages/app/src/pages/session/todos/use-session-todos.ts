import { createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { composerDriver, composerEnabled, composerEvent } from "@/testing/session-composer"
import {
  createTodoDockRestoreTracker,
  reduceTodoDockState,
  TODO_DOCK_COMPLETING_DELAY_MS,
  todoDockHiddenState,
} from "./todo-dock-machine"
import { todoSnapshot, type SessionTodoItem, type TodoSnapshot } from "./todo-model"
import { selectSessionTodoDockSnapshot } from "./todo-source"

export const isTodoSnapshotKnownForRestore = (input: {
  sessionID?: string
  testTodosKnown: boolean
  source: TodoSnapshot["source"]
  syncTodoKnown: boolean
  globalTodoKnown: boolean
}) => {
  if (!input.sessionID) return true
  if (input.testTodosKnown) return true
  return input.syncTodoKnown || input.globalTodoKnown
}

const dockInput = (snapshot: TodoSnapshot, sessionID?: string, restored?: boolean) => ({
  sessionID: snapshot.sessionID ?? sessionID,
  count: snapshot.items.length,
  phase: snapshot.phase,
  lifecycleSignature: snapshot.lifecycleSignature,
  sourceUpdatedAt: snapshot.sourceUpdatedAt,
  dockEligible: snapshot.dockEligible,
  restored,
  historicalTerminal: snapshot.historicalTerminal,
})

export function createSessionTodoModel(input: {
  sessionID: () => string | undefined
  fallbackSessionID?: () => string | undefined
}) {
  const sync = useSync()
  const globalSync = useGlobalSync()
  const activeSessionID = input.sessionID
  const restoredSnapshot = createTodoDockRestoreTracker()

  const [test, setTest] = createStore({
    on: false,
    todos: undefined as SessionTodoItem[] | undefined,
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

    window.addEventListener(composerEvent, onEvent)
    onCleanup(() => window.removeEventListener(composerEvent, onEvent))
  })

  const snapshot = createMemo((): TodoSnapshot => {
    const id = activeSessionID()
    if (test.on && test.todos !== undefined) {
      return todoSnapshot({
        sessionID: id,
        source: test.todos.length > 0 ? "primary-backend" : "none",
        items: test.todos,
      })
    }
    if (!id) return todoSnapshot({ source: "none", items: [] })

    const messages = sync.data.message[id] ?? []
    const parts = messages.flatMap((message) => sync.data.part[message.id] ?? [])
    const fallbackID = input.fallbackSessionID?.()
    const fallbackMessages = fallbackID && fallbackID !== id ? (sync.data.message[fallbackID] ?? []) : []
    const fallbackParts = fallbackMessages.flatMap((message) => sync.data.part[message.id] ?? [])

    return selectSessionTodoDockSnapshot({
      primary: {
        sessionID: id,
        backend: globalSync.data.session_todo[id],
        backendClearActivePartsAt: globalSync.data.session_todo_clear[id],
        parts,
      },
      fallback: fallbackID
        ? {
            sessionID: fallbackID,
            backend: globalSync.data.session_todo[fallbackID],
            backendClearActivePartsAt: globalSync.data.session_todo_clear[fallbackID],
            parts: fallbackParts,
          }
        : undefined,
    })
  })

  const snapshotKnown = (current: TodoSnapshot, sessionID?: string) => {
    return isTodoSnapshotKnownForRestore({
      sessionID,
      testTodosKnown: test.on && test.todos !== undefined,
      source: current.source,
      syncTodoKnown: sessionID ? sync.data.todo[sessionID] !== undefined : false,
      globalTodoKnown: sessionID ? globalSync.data.session_todo[sessionID] !== undefined : false,
    })
  }

  const currentDockInput = (current: TodoSnapshot) => {
    const sessionID = current.sessionID ?? activeSessionID()
    return dockInput(
      current,
      activeSessionID(),
      restoredSnapshot({
        sessionID,
        known: snapshotKnown(current, sessionID),
        source: current.source,
        count: current.items.length,
        phase: current.phase,
        sourceUpdatedAt: current.sourceUpdatedAt,
      }),
    )
  }

  let machine = reduceTodoDockState(todoDockHiddenState(), {
    type: "snapshot",
    input: currentDockInput(snapshot()),
  })
  const [dock, setDock] = createStore({
    dock: machine.dock,
    opening: machine.opening,
    completing: machine.completing,
  })
  let raf: number | undefined
  let hideTimeout: number | undefined

  const clearAnimationFrame = () => {
    if (raf === undefined) return
    cancelAnimationFrame(raf)
    raf = undefined
  }

  const clearHideTimeout = () => {
    if (hideTimeout === undefined) return
    window.clearTimeout(hideTimeout)
    hideTimeout = undefined
  }

  const publish = () => {
    setDock({ dock: machine.dock, opening: machine.opening, completing: machine.completing })
  }

  const dispatch = (transition: Parameters<typeof reduceTodoDockState>[1]) => {
    const previous = machine
    const next = reduceTodoDockState(machine, transition)
    if (next === previous) return

    machine = next
    publish()

    if (next.kind !== "visible-completing") clearHideTimeout()
    if (next.kind !== "visible-active" || !next.opening) clearAnimationFrame()

    if (next.kind === "visible-active" && next.opening) {
      clearAnimationFrame()
      raf = requestAnimationFrame(() => {
        raf = undefined
        dispatch({ type: "animationFrameElapsed" })
      })
    }

    if (next.kind === "visible-completing") {
      clearHideTimeout()
      const { sessionID, lifecycleSignature } = next
      hideTimeout = window.setTimeout(() => {
        hideTimeout = undefined
        dispatch({ type: "hideTimerElapsed", sessionID, lifecycleSignature })
      }, TODO_DOCK_COMPLETING_DELAY_MS)
    }
  }

  createEffect(
    on(
      () => {
        const current = snapshot()
        return currentDockInput(current)
      },
      (current) => dispatch({ type: "snapshot", input: current }),
    ),
  )

  onCleanup(() => {
    clearAnimationFrame()
    clearHideTimeout()
  })

  return {
    snapshot,
    todos: () => snapshot().items,
    dock: () => dock.dock,
    opening: () => dock.opening,
    completing: () => dock.completing,
  }
}
