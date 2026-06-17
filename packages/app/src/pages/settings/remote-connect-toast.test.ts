import { expect, test } from "bun:test"
import { connectToastAction } from "./remote-connect-toast"

test("fires the success toast only when an armed connect actually reaches connected", () => {
  expect(connectToastAction(true, "connected")).toBe("fire")
})

test("a 409 that ends in degraded disarms without a success toast", () => {
  // The P2 case: Allow was clicked (armed), but the bridge never serves (another
  // client owns the token). No false "connected" toast — the status row shows it.
  expect(connectToastAction(true, "degraded")).toBe("disarm")
  expect(connectToastAction(true, "disconnected")).toBe("disarm")
})

test("stays armed while still connecting", () => {
  expect(connectToastAction(true, "connecting")).toBe("none")
})

test("launch-time auto-reconnect (not armed) never toasts", () => {
  // startIfConfigured connects without a user Allow; awaiting is false, so reaching
  // connected must stay silent.
  expect(connectToastAction(false, "connected")).toBe("none")
  expect(connectToastAction(false, "degraded")).toBe("none")
})
