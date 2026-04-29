import { describe, expect, test } from "bun:test"
import { nextSessionViewState, nextTimelineSessionID, nextVisibleSessionID, sessionKey } from "./timeline-session-state"
import * as controller from "./session-view-controller"

describe("timeline-session-state", () => {
  test("keeps the legacy exports wired to the session view controller", () => {
    expect(nextSessionViewState).toBe(controller.nextSessionViewState)
    expect(nextVisibleSessionID).toBe(controller.nextVisibleSessionID)
    expect(nextTimelineSessionID).toBe(controller.nextVisibleSessionID)
    expect(sessionKey).toBe(controller.sessionKey)
  })
})
