import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { adapter } from "#hono"
import { ControlPlaneRoutes } from "./routes/control"
import { GlobalRoutes } from "./routes/global"
import { InstanceRoutes } from "./routes/instance"
import { InstanceMiddleware } from "./routes/instance/middleware"
import { WorkspaceRoutes } from "./routes/control/workspace"

export async function legacyServerOpenApi() {
  // Spec-generation compatibility only. Production requests are dispatched by
  // the native server app in server.ts, not this Hono documentation tree.
  const app = new Hono().route("/global", GlobalRoutes())
  const runtime = adapter.create(app)
  const documented = app
    .route("/", ControlPlaneRoutes())
    .route("/experimental/workspace", new Hono().use(InstanceMiddleware()).route("/", WorkspaceRoutes()))
    .route("/", new Hono().use(InstanceMiddleware()).route("/", InstanceRoutes(runtime.upgradeWebSocket)))

  return generateSpecs(documented, {
    documentation: {
      info: {
        title: "opencode",
        version: "1.0.0",
        description: "opencode api",
      },
      openapi: "3.1.1",
    },
  })
}
