import { expect, test } from "bun:test"
import { connectToastAction } from "./connect-toast"

test("the connect toast fires only on the real connected transition, once armed", () => {
  // Unarmed (launch-time auto-reconnect) stays silent regardless of state.
  expect(connectToastAction(false, "connected")).toBe("none")
  // Armed: connecting keeps waiting; connected fires; terminal failures disarm.
  expect(connectToastAction(true, "connecting")).toBe("none")
  expect(connectToastAction(true, "connected")).toBe("fire")
  expect(connectToastAction(true, "degraded")).toBe("disarm")
  expect(connectToastAction(true, "disconnected")).toBe("disarm")
})
