import type { RemoteStatus } from "@/desktop-api-contract"

export type ConnectToastAction = "fire" | "disarm" | "none"

/**
 * Decide what the deferred connect success toast should do on a status change.
 *
 * The toast is armed only after the user clicks Allow (`awaiting`), so launch-time
 * auto-reconnect stays silent. It fires exactly when status reaches "connected" —
 * not the moment Allow returns, which is a step before the bridge is actually
 * serving. A terminal non-connected outcome ("degraded" from a 409 where another
 * client owns the token, or "disconnected") disarms with no toast (the status row
 * already shows the cause); "connecting" keeps waiting.
 */
export function connectToastAction(awaiting: boolean, next: RemoteStatus["state"]): ConnectToastAction {
  if (!awaiting) return "none"
  if (next === "connected") return "fire"
  if (next === "degraded" || next === "disconnected") return "disarm"
  return "none" // "connecting": still pending, stay armed
}
