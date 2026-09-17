import { randomBytes } from "node:crypto"
import { createGrantStore } from "./grant-store.js"
import { createOAuthProvider } from "./oauth-provider.js"
import { startCallbackServer } from "./callback-server.js"
import { assertServer } from "./server-list.js"

export const SERVER_STATE = {
  UNAUTHORIZED: "unauthorized",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  EXPIRED: "expired",
}
const PLACEHOLDER_REDIRECT_URL = "http://127.0.0.1:19750/mcp/oauth/callback"

/** Each runtime owns its provider, writes, browser flow and fork until cancelled. */
export function createMcpOAuthEngine({ credentials, fork, sdk, logger = {} }) {
  const entries = new Map()
  let configuration = {}

  function must(serverName) {
    const entry = entries.get(serverName)
    if (!configuration || entry === undefined || entry.removing) throw new Error("mcp-oauth: no remote MCP server named " + JSON.stringify(serverName))
    return entry
  }

  function createRuntime(entry) {
    const controller = new AbortController()
    const run = { controller, redirectUrl: PLACEHOLDER_REDIRECT_URL, pending: undefined, callback: undefined, fork: undefined, connecting: undefined, provider: undefined }
    run.provider = createOAuthProvider({
      store: entry.store,
      signal: controller.signal,
      redirectUrl: () => run.redirectUrl,
      state: () => run.pending?.state,
      onRedirect: (url) => {
        if (run.pending) run.pending.authorizationUrl = url
        else entry.state = SERVER_STATE.EXPIRED
      },
    })
    entry.run = run
    return run
  }

  function auth(entry, run, authorizationCode) {
    return sdk.auth(run.provider, {
      serverUrl: entry.url,
      authorizationCode,
      fetchFn: (url, init) => fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, run.controller.signal]) : run.controller.signal,
      }),
    })
  }

  function connect(entry, run) {
    if (run.connecting) return run.connecting
    run.connecting = (async () => {
      try {
        run.controller.signal.throwIfAborted()
        const handle = await fork({ transport: "streamable-http", serverName: entry.serverName, url: entry.url, headers: entry.headers, reconnect: { maxAttempts: 3 }, failOnStartupError: true })
        if (run.controller.signal.aborted) {
          await handle.dispose()
          run.controller.signal.throwIfAborted()
        }
        run.fork = handle
        entry.state = SERVER_STATE.CONNECTED
        entry.lastError = undefined
        logger.info?.("mcp-oauth: connected " + entry.serverName)
      } catch (error) {
        if (!run.controller.signal.aborted) {
          if (entry.state !== SERVER_STATE.EXPIRED) entry.state = SERVER_STATE.DISCONNECTED
          entry.lastError = String(error)
        }
        throw error
      }
    })()
    return run.connecting
  }

  // Invalidation is synchronous. Cleanup joins outstanding work before another
  // runtime can reuse the server name or delete its credential record.
  function stop(entry) {
    const run = entry.run
    if (!run) return entry.stopping ?? Promise.resolve()
    entry.run = undefined
    run.controller.abort()
    const pending = run.pending
    const prior = entry.stopping
    entry.stopping = (async () => {
      await prior
      await run.callback?.close()
      await pending?.started?.catch(() => {})
      await pending?.completion
      await run.connecting?.catch(() => {})
      await run.fork?.dispose()
    })()
    return entry.stopping
  }

  async function settle(entry, run, pending) {
    try {
      const result = await run.callback.settled
      await run.callback.close()
      run.controller.signal.throwIfAborted()
      if (result.code === undefined) throw new Error(result.error)
      await auth(entry, run, result.code)
      await connect(entry, run)
      return { state: entry.state }
    } catch (error) {
      if (run.controller.signal.aborted) return { error: "cancelled" }
      entry.lastError = String(error)
      return { state: entry.state, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (run.pending === pending) run.pending = undefined
    }
  }

  function buildEntry(definition) {
    definition = assertServer(definition)
    return {
      ...definition,
      headers: definition.headers ?? {},
      store: createGrantStore(credentials, { serverName: definition.serverName, serverUrl: definition.url }),
      state: SERVER_STATE.UNAUTHORIZED,
      run: undefined,
      stopping: undefined,
      removing: false,
      lastError: undefined,
    }
  }

  async function load(entry) {
    const run = createRuntime(entry)
    try {
      const grant = await entry.store.read(run.controller.signal)
      run.redirectUrl = grant.redirectUri ?? PLACEHOLDER_REDIRECT_URL
      if (grant.tokens !== undefined) await connect(entry, run)
    } catch (error) {
      if (!run.controller.signal.aborted) {
        if (entry.state !== SERVER_STATE.EXPIRED) entry.state = SERVER_STATE.DISCONNECTED
        entry.lastError = String(error)
      }
    }
  }

  return {
    async configure(definitions) {
      const current = {}
      configuration = current
      await Promise.all([...entries.values()].map(stop))
      if (configuration !== current) return this.status()
      entries.clear()
      for (const definition of definitions) {
        const entry = buildEntry(definition)
        entries.set(entry.serverName, entry)
      }
      for (const entry of entries.values()) {
        if (configuration !== current) break
        await load(entry)
      }
      return this.status()
    },
    async add(definition) {
      if (!configuration) throw new Error("mcp-oauth: engine is disposed")
      if (entries.has(definition.serverName)) throw new Error("mcp-oauth: server " + definition.serverName + " is already configured")
      const entry = buildEntry(definition)
      entries.set(entry.serverName, entry)
      await load(entry)
      return this.status()
    },
    async remove(serverName) {
      const entry = entries.get(serverName)
      if (!entry) return this.status()
      entry.removing = true
      try {
        await stop(entry)
        await entry.store.clear()
        entries.delete(serverName)
      } finally {
        entry.removing = false
      }
      return this.status()
    },
    providerFor(config) {
      const entry = entries.get(config.serverName)
      if (entry === undefined || config.transport !== "streamable-http" || config.url !== entry.url) return undefined
      return entry.run?.provider
    },
    status() {
      return [...entries.values()].map((entry) => ({
        serverName: entry.serverName,
        url: entry.url,
        state: entry.state,
        authorizationPending: entry.run?.pending !== undefined,
        lastError: entry.lastError,
      }))
    },
    authorize(serverName) {
      const entry = must(serverName)
      if (entry.run?.pending) return entry.run.pending.started
      const prior = stop(entry)
      const run = createRuntime(entry)
      const pending = { state: randomBytes(16).toString("hex"), started: undefined, completion: undefined, authorizationUrl: undefined }
      run.pending = pending
      entry.lastError = undefined
      pending.started = (async () => {
        try {
          await prior
          run.controller.signal.throwIfAborted()
          await entry.store.update({ tokens: undefined, codeVerifier: undefined }, run.controller.signal)
          entry.state = SERVER_STATE.UNAUTHORIZED
          run.callback = await startCallbackServer({ state: pending.state })
          run.controller.signal.throwIfAborted()
          run.controller.signal.addEventListener("abort", () => void run.callback.close(), { once: true })
          run.redirectUrl = run.callback.redirectUrl
          await auth(entry, run)
          run.controller.signal.throwIfAborted()
          if (pending.authorizationUrl === undefined) throw new Error("mcp-oauth: the authorization server returned no URL to open")
          pending.completion = settle(entry, run, pending)
          return { authorizationUrl: pending.authorizationUrl, completion: pending.completion }
        } catch (error) {
          await run.callback?.close()
          run.pending = undefined
          if (!run.controller.signal.aborted) entry.lastError = String(error)
          throw error
        }
      })()
      return pending.started
    },
    async signOut(serverName) {
      const entry = must(serverName)
      entry.stopping = stop(entry).then(() => entry.store.clear())
      entry.state = SERVER_STATE.UNAUTHORIZED
      entry.lastError = undefined
      await entry.stopping
    },
    async dispose() {
      configuration = undefined
      await Promise.all([...entries.values()].map(stop))
    },
  }
}
