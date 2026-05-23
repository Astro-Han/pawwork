import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { createRoot, createSignal } from "solid-js"
import { useSessionRefreshEffects } from "./src/pages/session/use-session-refresh-effects.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

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
}

const installTimerQueue = () => {
  let nextID = 1
  const timers = new Map()

  window.setTimeout = (callback) => {
    const id = nextID++
    timers.set(id, callback)
    return id
  }

  window.clearTimeout = (id) => {
    timers.delete(id)
  }
}

const mountRefreshEffects = ({ hasTodoCache, recoveryEpoch = () => 0, validatedRecoveryEpoch = () => 0 }) => {
  const scheduledTodos = []
  const canceledTodos = []
  const syncedTodos = []

  const dispose = createRoot((dispose) => {
    const [directory] = createSignal("dir-a")
    const [sessionID] = createSignal("ses_initial")

    useSessionRefreshEffects({
      directory,
      routeSessionID: sessionID,
      timelineSessionID: sessionID,
      statusType: () => "idle",
      blocked: () => false,
      hasMessageCache: () => true,
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
      syncSession: () => {},
      syncTodo: (sessionID, options) => {
        syncedTodos.push({ sessionID, options })
      },
      emitRendererDiagnostic: () => {},
    })

    return dispose
  })

  return { dispose, scheduledTodos, canceledTodos, syncedTodos }
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
