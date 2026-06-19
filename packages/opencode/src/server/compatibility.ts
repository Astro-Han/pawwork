import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { AuthMiddleware, CompressionMiddleware, CorsMiddleware, ErrorMiddleware, LoggerMiddleware } from "./middleware"
import { EventRoutes } from "./instance/event"
import { createGlobalCompatibilityRoutes } from "./instance/global"
import { PtyConnectCompatibilityRoutes } from "./instance/pty"
import { WorkspaceWebSocketCompatibilityRoutes } from "./proxy"
import { UIRoutes } from "./routes/ui"

export function createCompatibilityApp(input: { cors?: string[]; upgradeWebSocket: UpgradeWebSocket }) {
  return new Hono()
    .onError(ErrorMiddleware)
    .use(CorsMiddleware(input))
    .use(LoggerMiddleware)
    .use(AuthMiddleware)
    .use(CompressionMiddleware)
    .route("/global", createGlobalCompatibilityRoutes())
    .route("/", EventRoutes())
    .route("/", WorkspaceWebSocketCompatibilityRoutes(input.upgradeWebSocket))
    .route("/pty", PtyConnectCompatibilityRoutes(input.upgradeWebSocket))
    .route("/", UIRoutes())
}
