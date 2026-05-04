import { describe, expect, test } from "bun:test"
import { shouldShowSessionOpeningState } from "./session-main-view-state"

describe("shouldShowSessionOpeningState", () => {
  test("shows a target session loading state while route messages are not ready", () => {
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: "ses_target",
        routeSessionID: "ses_target",
        routeReady: false,
        timelineSessionID: "ses_target",
      }),
    ).toBe(true)
  })

  test("does not replace the new-session home or ready timeline", () => {
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: undefined,
        routeSessionID: undefined,
        routeReady: false,
        timelineSessionID: undefined,
      }),
    ).toBe(false)
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: "ses_target",
        routeSessionID: "ses_target",
        routeReady: true,
        timelineSessionID: "ses_target",
      }),
    ).toBe(false)
  })

  test("does not show loading for a mismatched timeline identity", () => {
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: "ses_route",
        routeSessionID: "ses_route",
        routeReady: false,
        timelineSessionID: "ses_other",
      }),
    ).toBe(false)
  })
})
