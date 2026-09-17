/**
 * The remote-MCP authorization engine: one entry per configured server, each with
 * a state the product can show, a grant record that outlives the process, and at
 * most one live mcp-client instance.
 *
 * The SDK owns the protocol. This file owns only what the SDK cannot know: when a
 * human must be sent to a browser, which credential record belongs to which
 * server, and whether a server is currently allowed to hold tools.
 */
import { randomBytes } from "node:crypto"
import { createGrantStore } from "./grant-store.js"
import { createOAuthProvider } from "./oauth-provider.js"
import { startCallbackServer } from "./callback-server.js"

/** What the product shows for one server. */
export const SERVER_STATE = {
  UNAUTHORIZED: "unauthorized",
  CONNECTED: "connected",
  EXPIRED: "expired",
}

const RECONNECT = { maxAttempts: 3 }
// A server that redirects a reconnecting transport has no loopback server
// listening yet. Registering against this placeholder is harmless: the callback
// picks a real port, the registration is dropped on the next flow, and the SDK
// registers again with the URI that is actually in force.
const PLACEHOLDER_REDIRECT_URL = "http://127.0.0.1:19750/mcp/oauth/callback"

/**
 * @param options.credentials - `ctx.credentials` from the harness.
 * @param options.fork - `(config) => Promise<{ dispose(): Promise<void> }>`: the
 * mcp-client plugin loaded by the caller (cordis in production).
 * @param options.sdk - `{ auth }` re-exported by the installed mcp-client, so the
 * provider and the transports share one SDK instance.
 * @param options.logger - Optional `{ info, warn, error }`.
 */
export function createMcpOAuthEngine({ credentials, fork, sdk, logger = {} }) {
  const entries = new Map()

  const note = (level, message, detail) => {
    const write = logger[level]
    if (typeof write === "function") write(message, detail ?? "")
  }

  function must(serverName) {
    const entry = entries.get(serverName)
    if (entry === undefined) throw new Error("mcp-oauth: no remote MCP server named " + JSON.stringify(serverName))
    return entry
  }

  /** The provider the patched mcp-client asks for on every connect attempt. */
  function providerFor(entry) {
    if (entry.provider === undefined) {
      entry.provider = createOAuthProvider({
        store: entry.store,
        redirectUrl: () => entry.pending?.callback.redirectUrl ?? PLACEHOLDER_REDIRECT_URL,
        state: () => entry.pending?.state,
        onRedirect: (url) => {
          entry.authorizationUrl = url
          if (entry.state === SERVER_STATE.CONNECTED) entry.state = SERVER_STATE.EXPIRED
        },
      })
    }
    return entry.provider
  }

  /** Fork one mcp-client instance for this server and let it register its tools. */
  async function connect(entry) {
    if (entry.fork !== undefined) return
    entry.authorizationUrl = undefined
    try {
      entry.fork = await fork({
        transport: "streamable-http",
        serverName: entry.serverName,
        url: entry.url,
        headers: entry.headers,
        reconnect: RECONNECT,
        // A fork that cannot connect must not leave this entry reading
        // "connected": the bridge reports the first failed attempt instead of
        // staying quiet about it.
        failOnStartupError: true,
      })
    } catch (error) {
      entry.fork = undefined
      entry.lastError = String(error)
      // Only a request to send a human to a browser says the authorization
      // itself is gone. An unreachable server, a refused connection or a bad
      // gateway is reported as itself and never as a credential problem.
      entry.state =
        entry.authorizationUrl !== undefined
          ? SERVER_STATE.EXPIRED
          : entry.everConnected === true
            ? SERVER_STATE.CONNECTED
            : SERVER_STATE.UNAUTHORIZED
      throw error
    }
    entry.state = SERVER_STATE.CONNECTED
    entry.everConnected = true
    entry.authorizationUrl = undefined
    entry.lastError = undefined
    note("info", "mcp-oauth: connected " + entry.serverName)
  }

  async function dropFork(entry) {
    const held = entry.fork
    entry.fork = undefined
    if (held !== undefined) await held.dispose()
  }

  /** Wait for the loopback redirect, exchange the code, then allow tools. */
  async function settle(entry, pending) {
    const result = await pending.callback.settled
    await pending.callback.close()
    if (entry.pending === pending) entry.pending = undefined
    if (result.code === undefined) {
      entry.state = entry.state === SERVER_STATE.CONNECTED ? SERVER_STATE.EXPIRED : SERVER_STATE.UNAUTHORIZED
      entry.lastError = result.error
      note("warn", "mcp-oauth: authorization for " + entry.serverName + " ended as " + result.error)
      return { state: entry.state, error: result.error }
    }
    try {
      await sdk.auth(entry.provider, { serverUrl: entry.url, authorizationCode: result.code })
    } catch (error) {
      entry.state = SERVER_STATE.UNAUTHORIZED
      entry.lastError = String(error)
      note("error", "mcp-oauth: token exchange failed for " + entry.serverName, error)
      return { state: entry.state, error: String(error) }
    }
    await connect(entry)
    return { state: entry.state }
  }

  function buildEntry(definition) {
    return {
      serverName: definition.serverName,
      url: definition.url,
      headers: definition.headers ?? {},
      store: createGrantStore(credentials, { serverName: definition.serverName, serverUrl: definition.url }),
      state: SERVER_STATE.UNAUTHORIZED,
      everConnected: false,
      fork: undefined,
      provider: undefined,
      pending: undefined,
      authorizationUrl: undefined,
      lastError: undefined,
    }
  }

  /** A stored grant is what makes a server worth connecting at load time. */
  async function load(entry) {
    if ((await entry.store.read()).tokens === undefined) return
    try {
      await connect(entry)
    } catch (error) {
      // connect() already decided which state the failure means.
      entry.lastError = String(error)
      note("error", "mcp-oauth: could not connect " + entry.serverName, error)
    }
  }

  return {
    /** Load the configured servers, connecting the ones already authorized. */
    async configure(definitions) {
      for (const entry of entries.values()) {
        if (entry.pending !== undefined) await entry.pending.callback.close()
        await dropFork(entry)
      }
      entries.clear()
      for (const definition of definitions) {
        const entry = buildEntry(definition)
        entries.set(entry.serverName, entry)
        await load(entry)
      }
      return this.status()
    },

    /** Add one server at runtime; a stored grant for it connects immediately. */
    async add(definition) {
      if (entries.has(definition.serverName)) throw new Error("mcp-oauth: server " + definition.serverName + " is already configured")
      const entry = buildEntry(definition)
      entries.set(entry.serverName, entry)
      await load(entry)
      return this.status()
    },

    /** Remove one server: stop its tools, forget its grant, close any flow. */
    async remove(serverName) {
      const entry = must(serverName)
      if (entry.pending !== undefined) {
        const pending = entry.pending
        entry.pending = undefined
        await pending.callback.close()
      }
      await dropFork(entry)
      await entry.store.clear()
      entries.delete(serverName)
      note("info", "mcp-oauth: removed " + serverName)
      return this.status()
    },

    providerFor(config) {
      const entry = entries.get(config.serverName)
      if (entry === undefined || config.transport !== "streamable-http") return undefined
      return providerFor(entry)
    },

    /** One row per server, with nothing secret in it. */
    status() {
      return [...entries.values()].map((entry) => ({
        serverName: entry.serverName,
        url: entry.url,
        state: entry.state,
        authorizationUrl: entry.authorizationUrl,
        lastError: entry.lastError,
      }))
    },

    /**
     * Begin authorization and return the URL a human must open. `completion`
     * settles once the redirect arrived and the exchange finished.
     */
    async authorize(serverName) {
      const entry = must(serverName)
      if (entry.pending !== undefined) {
        return { authorizationUrl: entry.authorizationUrl, completion: entry.pending.completion }
      }
      const pending = { state: randomBytes(16).toString("hex"), callback: undefined, provider: undefined, completion: undefined }
      pending.callback = await startCallbackServer({ state: pending.state })
      pending.provider = createOAuthProvider({
        store: entry.store,
        redirectUrl: () => pending.callback.redirectUrl,
        state: () => pending.state,
        onRedirect: (url) => {
          entry.authorizationUrl = url
        },
      })
      entry.provider = pending.provider
      entry.authorizationUrl = undefined
      entry.lastError = undefined
      entry.pending = pending
      try {
        // With no stored tokens and no code to exchange, the SDK discovers the
        // authorization server, registers this client where the server supports
        // it, and asks for a redirect. No live transport is involved.
        await sdk.auth(pending.provider, { serverUrl: entry.url })
      } catch (error) {
        if (entry.pending === pending) entry.pending = undefined
        await pending.callback.close()
        entry.lastError = String(error)
        throw error
      }
      if (entry.authorizationUrl === undefined) {
        if (entry.pending === pending) entry.pending = undefined
        await pending.callback.close()
        throw new Error("mcp-oauth: the authorization server returned no URL to open")
      }
      pending.completion = settle(entry, pending)
      return { authorizationUrl: entry.authorizationUrl, completion: pending.completion }
    },

    /** Forget this server: stop its tools and delete its grant. */
    async signOut(serverName) {
      const entry = must(serverName)
      if (entry.pending !== undefined) {
        const pending = entry.pending
        entry.pending = undefined
        await pending.callback.close()
      }
      await dropFork(entry)
      await entry.store.clear()
      entry.state = SERVER_STATE.UNAUTHORIZED
      entry.authorizationUrl = undefined
      entry.lastError = undefined
      note("info", "mcp-oauth: signed out of " + entry.serverName)
    },

    async dispose() {
      for (const entry of entries.values()) {
        if (entry.pending !== undefined) await entry.pending.callback.close()
        await dropFork(entry)
      }
    },
  }
}
