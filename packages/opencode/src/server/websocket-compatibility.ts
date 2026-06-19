import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { PtyConnectCompatibilityRoutes } from "./instance/pty"
import { AuthMiddleware, ErrorMiddleware } from "./middleware"
import { WorkspaceWebSocketCompatibilityRoutes } from "./proxy"

export type WebSocketCompatibilityApp = {
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>
}

export function createWebSocketCompatibilityApp(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono()
    .onError(ErrorMiddleware)
    .use(AuthMiddleware)
    .route("/", WorkspaceWebSocketCompatibilityRoutes(upgradeWebSocket))
    .route("/pty", PtyConnectCompatibilityRoutes(upgradeWebSocket))
}
