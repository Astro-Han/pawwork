import { describe, expect, test } from "bun:test"
import { nextSessionViewState, nextTimelineSessionID, sessionKey } from "./timeline-session-state"

describe("nextTimelineSessionID", () => {
  test("keeps the rendered timeline session while the target route session is not ready", () => {
    expect(
      nextTimelineSessionID({
        current: "ses_source",
        route: "ses_target",
        routeReady: false,
      }),
    ).toBe("ses_source")
  })

  test("switches to the route session once its messages are ready", () => {
    expect(
      nextTimelineSessionID({
        current: "ses_source",
        route: "ses_target",
        routeReady: true,
      }),
    ).toBe("ses_target")
  })

  test("clears the rendered timeline when leaving a session route", () => {
    expect(
      nextTimelineSessionID({
        current: "ses_source",
        route: undefined,
        routeReady: true,
      }),
    ).toBeUndefined()
  })
})

describe("sessionKey", () => {
  test("keys a directory route without a session id", () => {
    expect(sessionKey({ directory: "repo", sessionID: undefined })).toBe("repo")
  })

  test("keys a concrete session route", () => {
    expect(sessionKey({ directory: "repo", sessionID: "ses_target" })).toBe("repo/ses_target")
  })
})

describe("nextSessionViewState", () => {
  test("keeps the visible session stable while the route session is still loading", () => {
    expect(
      nextSessionViewState({
        currentVisibleSessionID: "ses_source",
        directory: "repo",
        routeSessionID: "ses_target",
        routeMessagesReady: false,
      }),
    ).toEqual({
      routeSessionID: "ses_target",
      routeReady: false,
      visibleSessionID: "ses_source",
      transitioning: true,
      routeSessionKey: "repo/ses_target",
      visibleSessionKey: "repo/ses_source",
    })
  })

  test("moves the visible session to the route session once the route is ready", () => {
    expect(
      nextSessionViewState({
        currentVisibleSessionID: "ses_source",
        directory: "repo",
        routeSessionID: "ses_target",
        routeMessagesReady: true,
      }),
    ).toEqual({
      routeSessionID: "ses_target",
      routeReady: true,
      visibleSessionID: "ses_target",
      transitioning: false,
      routeSessionKey: "repo/ses_target",
      visibleSessionKey: "repo/ses_target",
    })
  })

  test("clears visible session state when leaving session routes", () => {
    expect(
      nextSessionViewState({
        currentVisibleSessionID: "ses_source",
        directory: "repo",
        routeSessionID: undefined,
        routeMessagesReady: true,
      }),
    ).toEqual({
      routeSessionID: undefined,
      routeReady: true,
      visibleSessionID: undefined,
      transitioning: false,
      routeSessionKey: "repo",
      visibleSessionKey: "repo",
    })
  })
})
