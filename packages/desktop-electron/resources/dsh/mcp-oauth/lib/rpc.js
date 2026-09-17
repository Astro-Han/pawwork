/**
 * The Integrations section's only way in: one loopback RPC channel that reads
 * state and asks the engine to authorize, retry, sign out, add or remove a
 * server. No token ever crosses it — the grant lives in the credential seam and
 * the browser leg goes straight from the renderer to the system browser.
 */
const rpcPayload = (payload) => {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("mcp-oauth: payload must be an object")
  return payload
}

const rpcSuccess = (value) => ({ ok: true, value })

// The code must be one DSH validates: an invented one fails response validation
// and the user sees that instead of our message. Our own reasons ride in details.
const rpcFailure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

function requireName(payload) {
  if (typeof payload.serverName !== "string" || payload.serverName.length === 0) throw new Error("mcp-oauth: serverName is required")
  return payload.serverName
}

export function createMcpOAuthRpcHandler({ engine }) {
  return async (endpoint, payload, signal) => {
    try {
      signal?.throwIfAborted()
      const args = rpcPayload(payload)
      if (endpoint === "status") return rpcSuccess(engine.status())
      if (endpoint === "authorize") {
        const { authorizationUrl, completion } = await engine.authorize(requireName(args))
        void Promise.resolve(completion).catch(() => {})
        return rpcSuccess({ authorizationUrl })
      }
      if (endpoint === "signOut") {
        await engine.signOut(requireName(args))
        return rpcSuccess(engine.status())
      }
      if (endpoint === "retry") {
        await engine.retry(requireName(args))
        return rpcSuccess(engine.status())
      }
      if (endpoint === "add") {
        if (typeof args.url !== "string" || args.url.length === 0) return rpcFailure("bad-request", "url is required")
        await engine.add({ serverName: requireName(args), url: args.url, headers: args.headers ?? {} })
        return rpcSuccess(engine.status())
      }
      if (endpoint === "remove") {
        await engine.remove(requireName(args))
        return rpcSuccess(engine.status())
      }
      return rpcFailure("bad-request", "unknown endpoint " + String(endpoint))
    } catch (error) {
      return rpcFailure("internal", error instanceof Error ? error.message : String(error))
    }
  }
}
