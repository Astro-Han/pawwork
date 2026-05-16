import { describe, expect, test } from "bun:test"

const browserCheck = String.raw`
import { createRoot, createSignal } from "solid-js"
import { createSessionDeferredRender } from "./src/pages/session/use-session-deferred-render.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const installAnimationFrameQueue = () => {
  let nextID = 1
  const frames = new Map()
  const canceled = []

  globalThis.requestAnimationFrame = (callback) => {
    const id = nextID++
    frames.set(id, callback)
    return id
  }

  globalThis.cancelAnimationFrame = (id) => {
    canceled.push(id)
    frames.delete(id)
  }

  return {
    canceled,
    pending: () => frames.size,
    pendingIDs: () => [...frames.keys()],
    flushOne: () => {
      const next = frames.entries().next()
      if (next.done) return false
      const [id, callback] = next.value
      frames.delete(id)
      callback(performance.now())
      return true
    },
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

  return {
    pending: () => timers.size,
    flushOne: () => {
      const next = timers.entries().next()
      if (next.done) return false
      const [id, callback] = next.value
      timers.delete(id)
      callback()
      return true
    },
  }
}

{
  const raf = installAnimationFrameQueue()
  const timers = installTimerQueue()
  let deferred
  let setSessionKey
  const dispose = createRoot((dispose) => {
    const [sessionKey, nextSessionKey] = createSignal("ses_1")
    setSessionKey = nextSessionKey
    deferred = createSessionDeferredRender(sessionKey)
    return dispose
  })

  await Promise.resolve()
  assert(deferred() === false, "initial session should not defer")
  assert(raf.pending() === 0, "initial session should not schedule a frame")

  setSessionKey("ses_2")
  await Promise.resolve()
  assert(deferred() === true, "session switch should defer rendering")
  assert(raf.pending() === 1, "session switch should schedule a frame")
  assert(raf.flushOne() === true, "defer frame should run")
  assert(deferred() === true, "render stays deferred until the timer boundary")
  assert(timers.flushOne() === true, "defer timer should run")
  assert(deferred() === false, "defer clears after frame and timer")
  dispose()
}

{
  const raf = installAnimationFrameQueue()
  installTimerQueue()
  let setSessionKey
  const dispose = createRoot((dispose) => {
    const [sessionKey, nextSessionKey] = createSignal("ses_1")
    setSessionKey = nextSessionKey
    createSessionDeferredRender(sessionKey)
    return dispose
  })

  await Promise.resolve()
  setSessionKey("ses_2")
  await Promise.resolve()
  const firstFrame = raf.pendingIDs()[0]
  assert(firstFrame !== undefined, "session switch should schedule a frame")
  setSessionKey("ses_3")
  await Promise.resolve()
  assert(raf.canceled.includes(firstFrame), "next session switch should cancel the previous frame")
  assert(raf.pending() === 1, "next session switch should leave one active frame")
  dispose()
}
`

describe("createSessionDeferredRender", () => {
  test("preserves deferred render scheduling behavior", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--conditions=browser", "--preload", "./happydom.ts", "-e", browserCheck],
      cwd: new URL("../../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    })

    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`
    expect(output).toBe("")
    expect(result.exitCode).toBe(0)
  })
})
