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
      expect(controller.route.key()).toBe("repo/ses_source")
      expect(controller.route.ready()).toBe(true)
      expect(controller.visible.id()).toBe("ses_source")
      expect(controller.visible.key()).toBe("repo/ses_source")
      expect(controller.visible.ready()).toBe(true)
      expect(controller.transitioning()).toBe(false)

      dispose()
    })
  })

  test("keeps route and visible state distinct while the route session is not ready", () => {
    createRoot((dispose) => {
      const controller = createSessionViewController({
        directory: () => "repo",
        routeSessionID: () => "ses_target",
        routeMessagesReady: () => false,
      })

      expect(controller.route.id()).toBe("ses_target")
      expect(controller.route.key()).toBe("repo/ses_target")
      expect(controller.route.ready()).toBe(false)
      expect(controller.visible.id()).toBeUndefined()
      expect(controller.visible.key()).toBe("repo")
      expect(controller.visible.ready()).toBe(false)
      expect(controller.transitioning()).toBe(true)

      dispose()
    })
  })
})

describe("nextSessionViewState", () => {
  test("keeps visible session on the previous ready session while route session loads", () => {
    const loading = nextSessionViewState({
      currentVisibleSessionID: "ses_source",
      directory: "repo",
      routeSessionID: "ses_target",
      routeMessagesReady: false,
    })

    expect(loading).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: "ses_source",
      transitioning: true,
      routeSessionKey: "repo/ses_target",
      visibleSessionKey: "repo/ses_source",
    })

    const ready = nextSessionViewState({
      currentVisibleSessionID: loading.visibleSessionID,
      directory: "repo",
      routeSessionID: "ses_target",
      routeMessagesReady: true,
    })

    expect(ready).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: true,
      visibleSessionID: "ses_target",
      transitioning: false,
      routeSessionKey: "repo/ses_target",
      visibleSessionKey: "repo/ses_target",
    })
  })

  test("clears visible session when leaving a concrete session route", () => {
    const next = nextSessionViewState({
      currentVisibleSessionID: "ses_source",
      directory: "repo",
      routeSessionID: undefined,
      routeMessagesReady: true,
    })

    expect(next.routeSessionID).toBeUndefined()
    expect(next.routeSessionKey).toBe("repo")
    expect(next.visibleSessionID).toBeUndefined()
    expect(next.visibleSessionKey).toBe("repo")
    expect(next.routeReady).toBe(true)
    expect(next.transitioning).toBe(false)
  })

  test("does not carry visible session state across directories", () => {
    const next = nextSessionViewState({
      currentVisibleDirectory: "repo-a",
      currentVisibleSessionID: "ses_source",
      directory: "repo-b",
      routeSessionID: "ses_target",
      routeMessagesReady: false,
    })

    expect(next).toMatchObject({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: undefined,
      transitioning: true,
      routeSessionKey: "repo-b/ses_target",
      visibleSessionKey: "repo-b",
    })
  })
})
