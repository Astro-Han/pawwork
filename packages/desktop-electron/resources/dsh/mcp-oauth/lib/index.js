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
import * as mcpClient from "@deepseek-ai/dsh-mcp-client"
import { createMcpOAuthEngine } from "./engine.js"
import { createServerList } from "./server-list.js"
import { McpAuthService } from "./service.js"

export const name = "mcp-oauth"

/** \`credentials\` holds the grant, and \`tools\` must exist before a fork can register. */
export const inject = ["credentials", "tools"]

const SERVER_FILE = "mcp-oauth.json"

export function apply(ctx) {
  const home = process.env.DSH_HOME
  if (!home || !path.isAbsolute(home)) throw new Error("PawWork remote MCP authorization requires an absolute DSH_HOME")
  // Read every service now, while this fiber is certainly active: reading a
  // service off a disposed context throws, and a throw inside a later callback
  // or disposer is an unhandled rejection.
  const { credentials, logger } = ctx
  const list = createServerList(path.join(home, SERVER_FILE))

  const engine = createMcpOAuthEngine({
    credentials,
    list,
    fork: (forkConfig) => ctx.plugin(mcpClient, forkConfig),
    sdk: { auth: mcpClient.auth },
    logger,
  })

  ctx.provide("mcpAuth", new McpAuthService(engine))

  ctx.effect(() => {
    void engine.configure(list.list()).catch((error) => {
      logger.error("mcp-oauth: could not load the configured servers", error)
    })
    return () => engine.dispose()
  }, "mcp-oauth.servers")
}
