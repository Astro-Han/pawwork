import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { createRoot, createSignal } from "solid-js"
import { clearSessionPrefetch, SESSION_PREFETCH_TTL, setSessionPrefetch } from "./src/context/global-sync/session-prefetch.ts"
import { useSessionRefreshEffects } from "./src/pages/session/use-session-refresh-effects.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const now = 1_000_000
Date.now = () => now

const installAnimationFrameQueue = () => {
  let nextID = 1
  const frames = new Map()

  globalThis.requestAnimationFrame = (callback) => {
    const id = nextID++
    frames.set(id, callback)
    return id
  }

  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id)
  }

  return {
    runFrame: () => {
      const pending = [...frames.entries()]
      frames.clear()
      for (const [, callback] of pending) callback(0)
    },
  }
}

const installTimerQueue = () => {
  let nextID = 1
  const timers = new Map()

  window.setTimeout = (callback, ms = 0) => {
    const id = nextID++
    timers.set(id, { callback, ms })
    return id
  }

  window.clearTimeout = (id) => {
    timers.delete(id)
  }

  return {
    runDue: (maxMs) => {
      const due = [...timers.entries()].filter(([, timer]) => timer.ms <= maxMs)
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue
        timer.callback()
      }
    },
    runAll: () => {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, timer] of pending) timer.callback()
    },
  }
}

const mountRefreshEffects = ({
  hasMessageCache = () => true,
  hasTodoCache,
  recoveryEpoch = () => 0,
  validatedRecoveryEpoch = () => 0,
  initialSessionID = "ses_initial",
}) => {
  const scheduledTodos = []
  const canceledTodos = []
  const syncedSessions = []
  const syncedTodos = []

  const root = createRoot((dispose) => {
    const [directory] = createSignal("dir-a")
    const [sessionID, setSessionID] = createSignal(initialSessionID)

    useSessionRefreshEffects({
      directory,
      routeSessionID: sessionID,
      timelineSessionID: sessionID,
      statusType: () => "idle",
      blocked: () => false,
      hasMessageCache,
      hasTodoCache,
      isTodoInvalidated: () => false,
      scheduleTodoHydrate: (directory, sessionID, reason) => {
        scheduledTodos.push({ directory, sessionID, reason })
      },
      cancelTodoHydrate: (directory, sessionID) => {
        canceledTodos.push({ directory, sessionID })
      },
      recoveryEpoch,
      validatedRecoveryEpoch,
      syncSession: (sessionID, options) => {
        syncedSessions.push({ sessionID, options })
      },
      syncTodo: (sessionID, options) => {
        syncedTodos.push({ sessionID, options })
      },
      emitRendererDiagnostic: () => {},
    })

    return { dispose, setSessionID }
  })

  return { dispose: root.dispose, setSessionID: root.setSessionID, scheduledTodos, canceledTodos, syncedSessions, syncedTodos }
}

{
  installAnimationFrameQueue()
  installTimerQueue()
  const { dispose, scheduledTodos, syncedTodos } = mountRefreshEffects({ hasTodoCache: () => false })

  await Promise.resolve()
  assert(scheduledTodos.length === 1, "initial visible todo should schedule hydrate before the frame boundary")
  assert(scheduledTodos[0].directory === "dir-a", "initial todo schedule should use the current directory")
  assert(scheduledTodos[0].sessionID === "ses_initial", "initial todo schedule should use the visible session")
  assert(scheduledTodos[0].reason === "visible", "initial absent-cache todo schedule should use the visible reason")
  assert(syncedTodos.length === 0, "initial todo hydrate should not start before the frame boundary")
  dispose()
}

{
  installAnimationFrameQueue()
  installTimerQueue()
  const { dispose, scheduledTodos } = mountRefreshEffects({ hasTodoCache: () => true })

  await Promise.resolve()
  assert(scheduledTodos.length === 0, "initial cached idle todo should not schedule a redundant hydrate")
  dispose()
}

{
  const frames = installAnimationFrameQueue()
  const timers = installTimerQueue()
  clearSessionPrefetch("dir-a", ["ses_stale"])
  setSessionPrefetch({
    directory: "dir-a",
    sessionID: "ses_stale",
    limit: 200,
    complete: false,
    at: Date.now() - SESSION_PREFETCH_TTL,
  })
  const { dispose, syncedSessions } = mountRefreshEffects({
    initialSessionID: "ses_stale",
    hasMessageCache: () => true,
    hasTodoCache: () => true,
  })

  await Promise.resolve()
  assert(syncedSessions.length === 1, "stale cached message session should start with the normal sync only")
  assert(!syncedSessions[0].options?.force, "initial stale cached message sync should not be forced")

  frames.runFrame()
  timers.runDue(499)
  await Promise.resolve()
  assert(syncedSessions.length === 1, "stale cached message force should not run before 500ms")

  timers.runDue(500)
  await Promise.resolve()
  assert(syncedSessions.length === 2, "stale cached message force should run at 500ms when it remains stale")
  assert(syncedSessions[1].options?.force === true, "delayed stale cached message sync should be forced")
  clearSessionPrefetch("dir-a", ["ses_stale"])
  dispose()
}

{
  const frames = installAnimationFrameQueue()
  const timers = installTimerQueue()
  clearSessionPrefetch("dir-a", ["ses_freshened"])
  setSessionPrefetch({
    directory: "dir-a",
    sessionID: "ses_freshened",
    limit: 200,
    complete: false,
    at: Date.now() - SESSION_PREFETCH_TTL - 1,
  })
  const { dispose, syncedSessions } = mountRefreshEffects({
    initialSessionID: "ses_freshened",
    hasMessageCache: () => true,
    hasTodoCache: () => true,
  })

  await Promise.resolve()
  frames.runFrame()
  setSessionPrefetch({
    directory: "dir-a",
    sessionID: "ses_freshened",
    limit: 200,
    complete: false,
    at: Date.now(),
  })
  timers.runAll()
  await Promise.resolve()
  assert(syncedSessions.length === 1, "freshened cached message session should not force refresh from a captured stale flag")
  clearSessionPrefetch("dir-a", ["ses_freshened"])
  dispose()
}

{
  installAnimationFrameQueue()
  installTimerQueue()
  const [recoveryEpoch, setRecoveryEpoch] = createSignal(1)
  const [validatedRecoveryEpoch, setValidatedRecoveryEpoch] = createSignal(0)
  const { dispose, scheduledTodos, canceledTodos } = mountRefreshEffects({
    hasTodoCache: () => true,
    recoveryEpoch,
    validatedRecoveryEpoch,
  })

  await Promise.resolve()
  assert(scheduledTodos.length === 1, "stale cached todo should schedule recovery hydrate")
  assert(scheduledTodos[0].reason === "recovery", "stale cached todo schedule should use recovery reason")

  setValidatedRecoveryEpoch(1)
  await Promise.resolve()
  assert(canceledTodos.length === 1, "validated recovery change should cancel the stale recovery hydrate")

  setRecoveryEpoch(2)
  await Promise.resolve()
  assert(scheduledTodos.length === 2, "new recovery epoch should schedule another recovery hydrate")
  dispose()
}
`

describe("useSessionRefreshEffects", () => {
  test("schedules initial visible todo hydrate before the frame boundary", () => {
    runBrowserCheck(browserCheck)
  })
})
