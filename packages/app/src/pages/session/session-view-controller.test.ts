import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionViewController, nextSessionViewState, timelineIdentity } from "./session-view-controller"
import { sessionScopeKey } from "./session-scope"

const scope = (serverKey: string, sessionID: string) => ({ serverKey, sessionID })

describe("timelineIdentity", () => {
  test("uses server and session identity without directory input", () => {
    const target = scope("sidecar", "ses_target")
    expect(timelineIdentity({ scope: target })).toBe(sessionScopeKey(target))
    expect(timelineIdentity({ scope: undefined })).toBe("")
  })
})

describe("createSessionViewController", () => {
  test("exposes route and visible session state through separate accessors", () => {
    createRoot((dispose) => {
      const controller = createSessionViewController({
        routeSessionID: () => "ses_source",
        routeScope: () => scope("sidecar", "ses_source"),
        routeMessagesReady: () => true,
      })

      expect(controller.route.id()).toBe("ses_source")
      expect(controller.route.key()).toBe(sessionScopeKey(scope("sidecar", "ses_source")))
      expect(controller.route.ready()).toBe(true)
      expect(controller.visible.id()).toBe("ses_source")
      expect(controller.visible.key()).toBe(sessionScopeKey(scope("sidecar", "ses_source")))
      expect(controller.visible.scope()).toEqual(scope("sidecar", "ses_source"))
      expect(controller.visible.ready()).toBe(true)
      expect(controller.transitioning()).toBe(false)

      dispose()
    })
  })

  test("keeps route and visible identity aligned while the route session is not ready", () => {
    createRoot((dispose) => {
      const controller = createSessionViewController({
        routeSessionID: () => "ses_target",
        routeScope: () => scope("sidecar", "ses_target"),
        routeMessagesReady: () => false,
      })

      expect(controller.route.id()).toBe("ses_target")
      expect(controller.route.key()).toBe(sessionScopeKey(scope("sidecar", "ses_target")))
      expect(controller.route.ready()).toBe(false)
      expect(controller.visible.id()).toBe("ses_target")
      expect(controller.visible.key()).toBe(sessionScopeKey(scope("sidecar", "ses_target")))
      expect(controller.visible.ready()).toBe(false)
      expect(controller.transitioning()).toBe(true)

      dispose()
    })
  })
})

describe("nextSessionViewState", () => {
  test("does not keep the previous visible session while the route session loads", () => {
    const loading = nextSessionViewState({
      routeSessionID: "ses_target",
      routeScope: scope("sidecar", "ses_target"),
      routeMessagesReady: false,
    })

    expect(loading).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: "ses_target",
      transitioning: true,
      routeSessionKey: sessionScopeKey(scope("sidecar", "ses_target")),
      visibleSessionKey: sessionScopeKey(scope("sidecar", "ses_target")),
    })

    const ready = nextSessionViewState({
      routeSessionID: "ses_target",
      routeScope: scope("sidecar", "ses_target"),
      routeMessagesReady: true,
    })

    expect(ready).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: true,
      visibleSessionID: "ses_target",
      transitioning: false,
      routeSessionKey: sessionScopeKey(scope("sidecar", "ses_target")),
      visibleSessionKey: sessionScopeKey(scope("sidecar", "ses_target")),
    })
  })

  test("clears visible session when leaving a concrete session route", () => {
    const next = nextSessionViewState({
      routeSessionID: undefined,
      routeScope: undefined,
      routeMessagesReady: true,
    })

    expect(next.routeSessionID).toBeUndefined()
    expect(next.routeSessionKey).toBe("")
    expect(next.visibleSessionID).toBeUndefined()
    expect(next.visibleSessionKey).toBe("")
    expect(next.routeReady).toBe(true)
    expect(next.transitioning).toBe(false)
  })

  test("uses session identity without a directory input", () => {
    const next = nextSessionViewState({
      routeSessionID: "ses_target",
      routeScope: scope("sidecar", "ses_target"),
      routeMessagesReady: false,
    })

    expect(next).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: "ses_target",
      transitioning: true,
      routeSessionKey: sessionScopeKey(scope("sidecar", "ses_target")),
      visibleSessionKey: sessionScopeKey(scope("sidecar", "ses_target")),
    })
  })

  test("keeps the same timeline identity and ready state across a transient directory cache miss", () => {
    const ready = nextSessionViewState({
      routeSessionID: "ses_target",
      routeScope: scope("sidecar", "ses_target"),
      routeMessagesReady: true,
    })

    const next = nextSessionViewState({
      routeSessionID: "ses_target",
      routeScope: scope("sidecar", "ses_target"),
      routeMessagesReady: false,
      previous: ready,
    })

    expect(next.routeSessionKey).toBe(sessionScopeKey(scope("sidecar", "ses_target")))
    expect(next.visibleSessionKey).toBe(sessionScopeKey(scope("sidecar", "ses_target")))
    expect(next.routeReady).toBe(true)
    expect(next.transitioning).toBe(false)
  })

  test("does not keep ready state when switching to another session", () => {
    const ready = nextSessionViewState({
      routeSessionID: "ses_source",
      routeScope: scope("sidecar", "ses_source"),
      routeMessagesReady: true,
    })

    const next = nextSessionViewState({
      routeSessionID: "ses_target",
      routeScope: scope("sidecar", "ses_target"),
      routeMessagesReady: false,
      previous: ready,
    })

    expect(next.routeSessionID).toBe("ses_target")
    expect(next.visibleSessionID).toBe("ses_target")
    expect(next.routeReady).toBe(false)
    expect(next.transitioning).toBe(true)
  })

  test("does not keep ready state for same session id under another server", () => {
    const ready = nextSessionViewState({
      routeSessionID: "ses_same",
      routeScope: scope("sidecar", "ses_same"),
      routeMessagesReady: true,
    })

    const next = nextSessionViewState({
      routeSessionID: "ses_same",
      routeScope: scope("https://remote.example", "ses_same"),
      routeMessagesReady: false,
      previous: ready,
    })

    expect(next.routeSessionKey).toBe(sessionScopeKey(scope("https://remote.example", "ses_same")))
    expect(next.routeReady).toBe(false)
    expect(next.transitioning).toBe(true)
  })
})
