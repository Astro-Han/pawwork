import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { PtyConnectCompatibilityRoutes } from "./instance/pty"
import { ErrorMiddleware } from "./middleware"
import { WorkspaceWebSocketCompatibilityRoutes } from "./proxy"

export function createWebSocketCompatibilityApp(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono()
    .onError(ErrorMiddleware)
    .route("/", WorkspaceWebSocketCompatibilityRoutes(upgradeWebSocket))
    .route("/pty", PtyConnectCompatibilityRoutes(upgradeWebSocket))
}
