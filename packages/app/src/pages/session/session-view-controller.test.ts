import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionViewController, nextSessionViewState } from "./session-view-controller"

describe("createSessionViewController", () => {
  test("exposes route and visible session state through separate accessors", () => {
    createRoot((dispose) => {
      const controller = createSessionViewController({
        directory: () => "repo",
        routeSessionID: () => "ses_source",
        routeMessagesReady: () => true,
      })

      expect(controller.route.id()).toBe("ses_source")
      expect(controller.route.key()).toBe("ses_source")
      expect(controller.route.ready()).toBe(true)
      expect(controller.visible.id()).toBe("ses_source")
      expect(controller.visible.key()).toBe("ses_source")
      expect(controller.visible.ready()).toBe(true)
      expect(controller.transitioning()).toBe(false)

      dispose()
    })
  })

  test("keeps route and visible identity aligned while the route session is not ready", () => {
    createRoot((dispose) => {
      const controller = createSessionViewController({
        directory: () => "repo",
        routeSessionID: () => "ses_target",
        routeMessagesReady: () => false,
      })

      expect(controller.route.id()).toBe("ses_target")
      expect(controller.route.key()).toBe("ses_target")
      expect(controller.route.ready()).toBe(false)
      expect(controller.visible.id()).toBe("ses_target")
      expect(controller.visible.key()).toBe("ses_target")
      expect(controller.visible.ready()).toBe(false)
      expect(controller.transitioning()).toBe(true)

      dispose()
    })
  })
})

describe("nextSessionViewState", () => {
  test("does not keep the previous visible session while the route session loads", () => {
    const loading = nextSessionViewState({
      directory: "repo",
      routeSessionID: "ses_target",
      routeMessagesReady: false,
    })

    expect(loading).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: "ses_target",
      transitioning: true,
      routeSessionKey: "ses_target",
      visibleSessionKey: "ses_target",
    })

    const ready = nextSessionViewState({
      directory: "repo",
      routeSessionID: "ses_target",
      routeMessagesReady: true,
    })

    expect(ready).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: true,
      visibleSessionID: "ses_target",
      transitioning: false,
      routeSessionKey: "ses_target",
      visibleSessionKey: "ses_target",
    })
  })

  test("clears visible session when leaving a concrete session route", () => {
    const next = nextSessionViewState({
      directory: "repo",
      routeSessionID: undefined,
      routeMessagesReady: true,
    })

    expect(next.routeSessionID).toBeUndefined()
    expect(next.routeSessionKey).toBe("")
    expect(next.visibleSessionID).toBeUndefined()
    expect(next.visibleSessionKey).toBe("")
    expect(next.routeReady).toBe(true)
    expect(next.transitioning).toBe(false)
  })

  test("uses the target route identity when changing directories", () => {
    const next = nextSessionViewState({
      directory: "repo-b",
      routeSessionID: "ses_target",
      routeMessagesReady: false,
    })

    expect(next).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: "ses_target",
      transitioning: true,
      routeSessionKey: "ses_target",
      visibleSessionKey: "ses_target",
    })
  })

  test("keeps the same timeline identity and ready state across a transient directory cache miss", () => {
    const ready = nextSessionViewState({
      directory: "repo-worktree",
      routeSessionID: "ses_target",
      routeMessagesReady: true,
    })

    const next = nextSessionViewState({
      directory: "repo-root",
      routeSessionID: "ses_target",
      routeMessagesReady: false,
      previous: ready,
    })

    expect(next.routeSessionKey).toBe("ses_target")
    expect(next.visibleSessionKey).toBe("ses_target")
    expect(next.routeReady).toBe(true)
    expect(next.transitioning).toBe(false)
  })

  test("does not keep ready state when switching to another session", () => {
    const ready = nextSessionViewState({
      directory: "repo",
      routeSessionID: "ses_source",
      routeMessagesReady: true,
    })

    const next = nextSessionViewState({
      directory: "repo",
      routeSessionID: "ses_target",
      routeMessagesReady: false,
      previous: ready,
    })

    expect(next.routeSessionID).toBe("ses_target")
    expect(next.visibleSessionID).toBe("ses_target")
    expect(next.routeReady).toBe(false)
    expect(next.transitioning).toBe(true)
  })
})
