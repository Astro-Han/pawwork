import { Effect } from "effect"
import { ConfigMCP, ConfigVariable } from "../../config"
import { MCP } from "../../mcp"
import { Instance } from "../../project/instance"
import type { Config } from "../../config/config"

export const getMcpStatus = Effect.fn("McpHttpApi.status")(function* () {
  const mcp = yield* MCP.Service
  return yield* mcp.status()
})

export const addMcpServer = Effect.fn("McpHttpApi.add")(function* (input: { name: string; config: Config.Mcp }) {
  const mcp = yield* MCP.Service
  return yield* mcp.add(input.name, input.config)
})

export const probeMcpServer = Effect.fn("McpHttpApi.probe")(function* (config: Config.Mcp) {
  const mcp = yield* MCP.Service
  const expanded = yield* Effect.promise(() =>
    ConfigVariable.substitute({
      text: JSON.stringify(config),
      type: "virtual",
      source: "MCP draft",
      dir: Instance.directory,
    }),
  )
  const resolved = ConfigMCP.Info.zod.parse(JSON.parse(expanded))
  return yield* mcp.probe(resolved)
})

export const startMcpAuth = Effect.fn("McpHttpApi.auth.start")(function* (name: string) {
  const mcp = yield* MCP.Service
  const supportsOAuth = yield* mcp.supportsOAuth(name)
  if (!supportsOAuth) return { type: "unsupported" as const }
  const { authorizationUrl, oauthState } = yield* mcp.startAuth(name)
  return { type: "started" as const, authorizationUrl, oauthState }
})

export const completeMcpAuth = Effect.fn("McpHttpApi.auth.callback")(function* (input: { name: string; code: string }) {
  const mcp = yield* MCP.Service
  return yield* mcp.finishAuth(input.name, input.code)
})

export const authenticateMcp = Effect.fn("McpHttpApi.auth.authenticate")(function* (name: string) {
  const mcp = yield* MCP.Service
  const supportsOAuth = yield* mcp.supportsOAuth(name)
  if (!supportsOAuth) return { type: "unsupported" as const }
  const status = yield* mcp.authenticate(name)
  return { type: "authenticated" as const, status }
})

export const removeMcpAuth = Effect.fn("McpHttpApi.auth.remove")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.removeAuth(name)
})

export const connectMcpServer = Effect.fn("McpHttpApi.connect")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.connect(name)
})

export const disconnectMcpServer = Effect.fn("McpHttpApi.disconnect")(function* (name: string) {
  const mcp = yield* MCP.Service
  yield* mcp.disconnect(name)
})
