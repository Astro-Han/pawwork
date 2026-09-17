/**
 * Remote MCP servers that need OAuth.
 *
 * The harness's own mcp-client bridge supplies the transport and the tool
 * registry; this plugin owns everything around the credential: where the grant is
 * stored, when a human is sent to a browser, which servers are configured, and
 * whether a server may hold tools at all. It answers the optional \`mcpAuth\`
 * service the patched bridge asks for, so a server configured without
 * authorization is untouched.
 */
import path from "node:path"
import z from "@deepseek-ai/schemastery"
import * as mcpClient from "@deepseek-ai/dsh-mcp-client"
import { createMcpOAuthEngine } from "./engine.js"
import { createServerList } from "./server-list.js"
import { createMcpOAuthRpcHandler } from "./rpc.js"

export const name = "mcp-oauth"

/** \`credentials\` holds the grant, \`tools\` must exist before a fork can register, and the Integrations section reaches the engine over \`connection\`. */
export const inject = ["credentials", "tools", "connection"]

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

const CHANNEL = "/pawwork-mcp-oauth"
const SERVER_FILE = "mcp-oauth.json"

export function apply(ctx, config) {
  const home = process.env.DSH_HOME
  if (!home || !path.isAbsolute(home)) throw new Error("PawWork remote MCP authorization requires an absolute DSH_HOME")
  const list = createServerList(path.join(home, SERVER_FILE))

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
    /** The bridge's hook: one provider per server, or nothing for servers it owns. */
    providerFor: (serverConfig) => engine.providerFor(serverConfig),
  })

  ctx.effect(() => {
    // A composition that ships a default list seeds the file once. After that the
    // file is the only authority the Integrations section reads and writes, so a
    // change made there and a change made here cannot disagree.
    if (list.list().length === 0 && (config.servers ?? []).length > 0) list.replace(config.servers)
    void engine.configure(list.list()).catch((error) => {
      ctx.logger.error("mcp-oauth: could not load the configured servers", error)
    })
    return () => void engine.dispose()
  }, "mcp-oauth.servers")

  ctx.effect(() => {
    const stopRpc = ctx.connection.rpc.handle(CHANNEL, createMcpOAuthRpcHandler({ engine, list }), { authority: "loopback" })
    return () => void stopRpc()
  }, "mcp-oauth.rpc")
}
