import { describe, expect, test } from "bun:test"
import { nextTimelineSessionID } from "./timeline-session-state"

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
