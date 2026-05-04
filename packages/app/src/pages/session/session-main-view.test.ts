import { describe, expect, test } from "bun:test"
import { shouldShowSessionOpeningState } from "./session-main-view-state"

describe("shouldShowSessionOpeningState", () => {
  test("shows a target session loading state while route messages are not ready", () => {
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: "ses_target",
        timelineSessionID: "ses_target",
        timelineMessagesReady: false,
      }),
    ).toBe(true)
  })

  test("does not replace the new-session home or ready timeline", () => {
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: undefined,
        timelineSessionID: undefined,
        timelineMessagesReady: false,
      }),
    ).toBe(false)
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: "ses_target",
        timelineSessionID: "ses_target",
        timelineMessagesReady: true,
      }),
    ).toBe(false)
  })

  test("does not show loading for a mismatched timeline identity", () => {
    expect(
      shouldShowSessionOpeningState({
        activeSessionID: "ses_route",
        timelineSessionID: "ses_other",
        timelineMessagesReady: false,
      }),
    ).toBe(false)
  })
})
