import { Effect } from "effect"
import { Config } from "../../config/config"
import { MCP } from "../../mcp"

export const getMcpStatus = Effect.fn("McpRoutes.status")(function* () {
  const mcp = yield* MCP.Service
  return yield* mcp.status()
})

export const addMcpServer = Effect.fn("McpRoutes.add")(function* (input: { name: string; config: Config.Mcp }) {
  const mcp = yield* MCP.Service
  return yield* mcp.add(input.name, input.config)
})

export const startMcpAuth = Effect.fn("McpRoutes.auth.start")(function* (name: string) {
  const mcp = yield* MCP.Service
  const supportsOAuth = yield* mcp.supportsOAuth(name)
  if (!supportsOAuth) return { type: "unsupported" as const }
  const { authorizationUrl, oauthState } = yield* mcp.startAuth(name)
  return { type: "started" as const, authorizationUrl, oauthState }
})

export const completeMcpAuth = Effect.fn("McpRoutes.auth.callback")(function* (input: { name: string; code: string }) {
  const mcp = yield* MCP.Service
  return yield* mcp.finishAuth(input.name, input.code)
})

export const authenticateMcp = Effect.fn("McpRoutes.auth.authenticate")(function* (name: string) {
  const mcp = yield* MCP.Service
  const supportsOAuth = yield* mcp.supportsOAuth(name)
  if (!supportsOAuth) return { type: "unsupported" as const }
  const status = yield* mcp.authenticate(name)
  return { type: "authenticated" as const, status }
})

export const removeMcpAuth = Effect.fn("McpRoutes.auth.remove")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.removeAuth(name)
})

export const connectMcpServer = Effect.fn("McpRoutes.connect")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.connect(name)
})

export const disconnectMcpServer = Effect.fn("McpRoutes.disconnect")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.disconnect(name)
})
