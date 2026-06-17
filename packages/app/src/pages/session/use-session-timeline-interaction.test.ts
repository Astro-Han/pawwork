import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { MemoryRouter, Route } from "@solidjs/router"
import { createRoot } from "solid-js"
import { createSessionTimelineInteraction } from "./src/pages/session/use-session-timeline-interaction.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
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

  globalThis.setTimeout = (callback, ms = 0) => {
    const id = nextID++
    timers.set(id, { callback, ms })
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
  }
  window.setTimeout = globalThis.setTimeout
  window.clearTimeout = globalThis.clearTimeout
}

const makeViewport = ({ scrollTop, clientHeight, scrollHeight }) => {
  const viewport = document.createElement("div")
  let top = scrollTop
  Object.defineProperties(viewport, {
    clientHeight: { value: clientHeight, configurable: true },
    scrollHeight: { value: scrollHeight, configurable: true },
    scrollTop: { configurable: true, get: () => top, set: (value) => { top = value } },
  })
  viewport.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 720,
    bottom: clientHeight,
    width: 720,
    height: clientHeight,
    toJSON: () => ({}),
  })
  viewport.scrollTo = ({ top }) => {
    viewport.scrollTop = top
  }
  return viewport
}

const frames = installAnimationFrameQueue()
installTimerQueue()
const viewport = makeViewport({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })
let interaction
const root = createRoot((dispose) => {
  MemoryRouter({
    children: Route({
      path: "*",
      component: () => {
        interaction = createSessionTimelineInteraction({
          routeSessionID: () => "ses_a",
          sessionKey: () => "dir-a:ses_a",
          sessionID: () => "ses_a",
          messagesReady: () => true,
          loadedMessages: () => 1,
          visibleUserMessages: () => [{ id: "msg_1" }],
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async () => {},
          consumePendingMessage: () => undefined,
        })
        interaction.setScrollRef(viewport)
        return null
      },
    }),
  })
  return { dispose }
})

assert(interaction, "timeline interaction should mount under the memory router")
interaction.onTimelineScrollObservation({
  type: "scroll_sample",
  userInitiated: false,
  safePosition: { kind: "latest" },
  metrics: {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    distanceFromTop: 0,
    distanceFromBottom: 600,
    nearTop: true,
    nearBottom: false,
  },
})

assert(viewport.scrollTop === 0, "system scroll drift should not synchronously write scrollTop")
frames.runFrame()
assert(viewport.scrollTop === 600, "system scroll drift should reconcile on the next frame")
root.dispose()
GlobalRegistrator.unregister()
`

describe("createSessionTimelineInteraction", () => {
  test("coalesces system scroll drift instead of writing scrollTop synchronously", () => {
    runBrowserCheck(browserCheck)
  })
})
