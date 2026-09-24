/**
 * The `mcpAuth` service. The patched mcp-client bridge asks it for one OAuth
 * provider per server; the Integrations section calls its Remote methods as
 * `/api/mcpAuth/<method>` to read state and to authorize, retry, sign out, add
 * or remove a server. No token ever crosses the wire — the grant lives in the
 * credential seam and the browser leg goes straight from the renderer to the
 * system browser.
 */
import { Remote, bindTypertRemote } from "@deepseek-ai/dsh-typert-protocol"

function requireName(serverName) {
  if (typeof serverName !== "string" || serverName.length === 0) throw new Error("mcp-oauth: serverName is required")
  return serverName
}

export class McpAuthService {
  constructor(engine) {
    this.engine = engine
    this.typertRemote = bindTypertRemote(this, "mcpAuth")
  }

  /** The bridge's hook: one provider per server, or nothing for servers it owns. */
  providerFor(serverConfig) {
    return this.engine.providerFor(serverConfig)
  }

  status() {
    return this.engine.status()
  }

  async authorize(serverName) {
    const { authorizationUrl, completion } = await this.engine.authorize(requireName(serverName))
    void Promise.resolve(completion).catch(() => {})
    return { authorizationUrl }
  }

  async signOut(serverName) {
    await this.engine.signOut(requireName(serverName))
    return this.engine.status()
  }

  async retry(serverName) {
    await this.engine.retry(requireName(serverName))
    return this.engine.status()
  }

  async add(serverName, url, headers) {
    if (typeof url !== "string" || url.length === 0) throw new Error("mcp-oauth: url is required")
    await this.engine.add({ serverName: requireName(serverName), url, headers: headers ?? {} })
    return this.engine.status()
  }

  async remove(serverName) {
    await this.engine.remove(requireName(serverName))
    return this.engine.status()
  }
}

// Applies @Remote the way a method decorator would; the sidecar's JavaScript has
// no decorator syntax.
for (const name of ["status", "authorize", "signOut", "retry", "add", "remove"]) {
  Remote(McpAuthService.prototype[name], {
    kind: "method",
    name,
    static: false,
    private: false,
    addInitializer: (initialize) => initialize.call(Object.create(McpAuthService.prototype)),
  })
}
