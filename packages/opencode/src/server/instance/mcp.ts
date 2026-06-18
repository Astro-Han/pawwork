import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { MCP } from "../../mcp"
import { Config } from "../../config/config"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { AppRuntime } from "../../effect/app-runtime"

const runMcpRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

const getMcpStatus = Effect.fn("McpRoutes.status")(function* () {
  const mcp = yield* MCP.Service
  return yield* mcp.status()
})

const addMcpServer = Effect.fn("McpRoutes.add")(function* (input: { name: string; config: Config.Mcp }) {
  const mcp = yield* MCP.Service
  return yield* mcp.add(input.name, input.config)
})

const startMcpAuth = Effect.fn("McpRoutes.auth.start")(function* (name: string) {
  const mcp = yield* MCP.Service
  const supportsOAuth = yield* mcp.supportsOAuth(name)
  if (!supportsOAuth) return { type: "unsupported" as const }
  const { authorizationUrl, oauthState } = yield* mcp.startAuth(name)
  return { type: "started" as const, authorizationUrl, oauthState }
})

const completeMcpAuth = Effect.fn("McpRoutes.auth.callback")(function* (input: { name: string; code: string }) {
  const mcp = yield* MCP.Service
  return yield* mcp.finishAuth(input.name, input.code)
})

const authenticateMcp = Effect.fn("McpRoutes.auth.authenticate")(function* (name: string) {
  const mcp = yield* MCP.Service
  const supportsOAuth = yield* mcp.supportsOAuth(name)
  if (!supportsOAuth) return { type: "unsupported" as const }
  const status = yield* mcp.authenticate(name)
  return { type: "authenticated" as const, status }
})

const removeMcpAuth = Effect.fn("McpRoutes.auth.remove")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.removeAuth(name)
})

const connectMcpServer = Effect.fn("McpRoutes.connect")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.connect(name)
})

const disconnectMcpServer = Effect.fn("McpRoutes.disconnect")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.disconnect(name)
})

export const McpRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get MCP status",
        description: "Get the status of all Model Context Protocol (MCP) servers.",
        operationId: "mcp.status",
        responses: {
          200: {
            description: "MCP server status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
        },
      }),
      async (c) => {
        const status = await runMcpRoute(getMcpStatus())
        return c.json(status)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Add MCP server",
        description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
        operationId: "mcp.add",
        responses: {
          200: {
            description: "MCP server added successfully",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Status)),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          config: Config.Mcp,
        }),
      ),
      async (c) => {
        const { name, config } = c.req.valid("json")
        const result = await runMcpRoute(addMcpServer({ name, config }))
        return c.json(result.status)
      },
    )
    .post(
      "/:name/auth",
      describeRoute({
        summary: "Start MCP OAuth",
        description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
        operationId: "mcp.auth.start",
        responses: {
          200: {
            description: "OAuth flow started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    authorizationUrl: z.string().describe("URL to open in browser for authorization"),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const result = await runMcpRoute(startMcpAuth(name))
        if (result.type === "unsupported") {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        return c.json({ authorizationUrl: result.authorizationUrl, oauthState: result.oauthState })
      },
    )
    .post(
      "/:name/auth/callback",
      describeRoute({
        summary: "Complete MCP OAuth",
        description:
          "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
        operationId: "mcp.auth.callback",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(MCP.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          code: z.string().describe("Authorization code from OAuth callback"),
        }),
      ),
      async (c) => {
        const name = c.req.param("name")
        const { code } = c.req.valid("json")
        const status = await runMcpRoute(completeMcpAuth({ name, code }))
        return c.json(status)
      },
    )
    .post(
      "/:name/auth/authenticate",
      describeRoute({
        summary: "Authenticate MCP OAuth",
        description: "Start OAuth flow and wait for callback (opens browser)",
        operationId: "mcp.auth.authenticate",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(MCP.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const result = await runMcpRoute(authenticateMcp(name))
        if (result.type === "unsupported") {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        return c.json(result.status)
      },
    )
    .delete(
      "/:name/auth",
      describeRoute({
        summary: "Remove MCP OAuth",
        description: "Remove OAuth credentials for an MCP server",
        operationId: "mcp.auth.remove",
        responses: {
          200: {
            description: "OAuth credentials removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        await runMcpRoute(removeMcpAuth(name))
        return c.json({ success: true as const })
      },
    )
    .post(
      "/:name/connect",
      describeRoute({
        description: "Connect an MCP server",
        operationId: "mcp.connect",
        responses: {
          200: {
            description: "MCP server connected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await runMcpRoute(connectMcpServer(name))
        return c.json(true)
      },
    )
    .post(
      "/:name/disconnect",
      describeRoute({
        description: "Disconnect an MCP server",
        operationId: "mcp.disconnect",
        responses: {
          200: {
            description: "MCP server disconnected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await runMcpRoute(disconnectMcpServer(name))
        return c.json(true)
      },
    ),
)
