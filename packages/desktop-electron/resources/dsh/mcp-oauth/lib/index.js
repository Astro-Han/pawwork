/**
 * Remote MCP servers that need OAuth.
 *
 * The harness's own mcp-client bridge supplies the transport and the tool
 * registry; this plugin owns everything around the credential: where the grant is
 * stored, when a human is sent to a browser, and whether a server may hold tools
 * at all. It answers the optional \`mcpAuth\` service the patched bridge asks for,
 * so a server configured without authorization is untouched.
 */
import z from "@deepseek-ai/schemastery"
import * as mcpClient from "@deepseek-ai/dsh-mcp-client"
import { createMcpOAuthEngine } from "./engine.js"

export const name = "mcp-oauth"

/** \`credentials\` holds the grant; \`tools\` must exist before a fork can register. */
export const inject = ["credentials", "tools"]

export const Config = z.object({
  servers: z
    .array(
      z.object({
        serverName: z.string(),
        url: z.string(),
        headers: z.dict(z.string()).default({}),
      }),
    )
    .default([]),
})

export function apply(ctx, config) {
  const engine = createMcpOAuthEngine({
    credentials: ctx.credentials,
    fork: (forkConfig) => ctx.plugin(mcpClient, forkConfig),
    sdk: { auth: mcpClient.auth },
    logger: {
      info: (message) => ctx.logger.info(message),
      warn: (message, detail) => ctx.logger.warn(message, detail),
      error: (message, detail) => ctx.logger.error(message, detail),
    },
  })

  ctx.provide("mcpAuth", {
    /** The bridge's hook: one provider per server, or nothing when unconfigured. */
    providerFor: (serverConfig) => engine.providerFor(serverConfig),
    status: () => engine.status(),
    authorize: (serverName) => engine.authorize(serverName),
    signOut: (serverName) => engine.signOut(serverName),
  })

  ctx.effect(() => {
    void engine.configure(config.servers ?? []).catch((error) => {
      ctx.logger.error("mcp-oauth: could not load the configured servers", error)
    })
    return () => void engine.dispose()
  }, "mcp-oauth.servers")
}
