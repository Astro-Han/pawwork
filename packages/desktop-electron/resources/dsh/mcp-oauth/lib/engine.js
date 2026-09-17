import { randomBytes } from "node:crypto"
import { createGrantStore } from "./grant-store.js"
import { createOAuthProvider } from "./oauth-provider.js"
import { startCallbackServer } from "./callback-server.js"
import { assertServer } from "./server-list.js"

export const SERVER_STATE = {
  UNAUTHORIZED: "unauthorized",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  EXPIRED: "expired",
}
const PLACEHOLDER_REDIRECT_URL = "http://127.0.0.1:19750/mcp/oauth/callback"

// A transport that keeps asking for a browser while nobody is waiting on one
// either holds a dead grant (the SDK just invalidated it) or faces a server
// that will not answer without authorization. The first redirects only mark
// the entry — a transient authorization-server outage lands here too and the
// retry can still heal itself — so the loop is stopped once it has proven a
// human is required.
const REDIRECT_LIMIT = 3

/** Each runtime owns its provider, writes, browser flow and fork until cancelled. */
export function createMcpOAuthEngine({ credentials, list, fork, sdk, logger = {} }) {
  const entries = new Map()
  let disposed = false

  /**
   * Every ownership change to one entry — creating, swapping or tearing down
   * its run — goes through that entry's lane, so two operations can never hold
   * a different `entry.run` at the same time. Lane work is limited to ownership
   * transfer and bounded joins: network waits hang off the run and are gated by
   * its abort signal, so a slow server cannot stall the lane and a cancellation
   * is never queued behind the work it is cancelling.
   */
  function enqueue(entry, op) {
    const result = entry.lane.then(op)
    entry.lane = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function must(serverName) {
    const entry = entries.get(serverName)
    if (disposed || entry === undefined) throw new Error("mcp-oauth: no remote MCP server named " + JSON.stringify(serverName))
    return entry
  }

  function gone(serverName) {
    return new Error("mcp-oauth: no remote MCP server named " + JSON.stringify(serverName))
  }

  function createRun(entry) {
    const controller = new AbortController()
    const run = {
      controller,
      redirectUrl: PLACEHOLDER_REDIRECT_URL,
      pending: undefined,
      callback: undefined,
      fork: undefined,
      connected: false,
      work: undefined,
      invalidated: false,
      redirects: 0,
      preAuthorized: false,
      provider: undefined,
    }
    run.provider = createOAuthProvider({
      store: entry.store,
      serverUrl: entry.url,
      headers: entry.headers,
      signal: controller.signal,
      redirectUrl: () => run.redirectUrl,
      state: () => run.pending?.state,
      onInvalidate: () => {
        run.invalidated = true
      },
      onRedirect: (url) => {
        if (run.pending !== undefined) {
          run.pending.authorizationUrl = url
          return
        }
        run.redirects += 1
        entry.authRequired = true
        if (run.invalidated || run.redirects >= REDIRECT_LIMIT) {
          void enqueue(entry, () => (entry.run === run ? stopRun(entry) : undefined)).catch(() => {})
        }
      },
    })
    entry.run = run
    return run
  }

  /**
   * Fork the patched bridge for this server. The fiber handle is captured
   * synchronously — before the await — so a rejection or an abort always leaves
   * a disposable handle and the server-name reservation is always released.
   * `failFast` reports the first attempt's outcome (user-triggered connects);
   * without it the bridge keeps retrying in the background so an outage heals
   * itself instead of unregistering the tools.
   */
  function connect(entry, run, failFast) {
    const fiber = fork({
      transport: "streamable-http",
      serverName: entry.serverName,
      url: entry.url,
      headers: entry.headers,
      reconnect: { maxAttempts: Number.MAX_SAFE_INTEGER },
      failOnStartupError: failFast,
    })
    run.fork = fiber
    return (async () => {
      try {
        await fiber
        run.controller.signal.throwIfAborted()
        // A resolved fiber proves only that the first attempt settled; a
        // redirect seen along the way means the server still wants a human.
        if (entry.run === run && run.redirects === 0) {
          entry.authRequired = false
          entry.lastError = undefined
          run.connected = true
        }
        logger.info?.("mcp-oauth: connected " + entry.serverName)
      } catch (error) {
        run.fork = undefined
        await Promise.resolve(fiber.dispose?.()).catch(() => {})
        if (!run.controller.signal.aborted && entry.run === run && !entry.authRequired) entry.lastError = String(error)
        throw error
      }
    })()
  }

  /**
   * Read the grant, then connect only when the record says it is worth trying:
   * tokens, or nothing at all — an open server needs no authorization and a
   * first probe is how the product learns that. Material without tokens means a
   * browser is needed before a connection can succeed.
   */
  function startLoad(entry, run, failFast) {
    entry.loading = true
    run.work = (async () => {
      try {
        const grant = await entry.store.read(run.controller.signal)
        run.controller.signal.throwIfAborted()
        run.redirectUrl = grant.redirectUri ?? PLACEHOLDER_REDIRECT_URL
        if (grant.tokens !== undefined && entry.run === run) entry.hadTokens = true
        const untouched = grant.tokens === undefined && grant.clientInformation === undefined && grant.discoveryState === undefined
        if (grant.tokens !== undefined || untouched) await connect(entry, run, failFast)
        else if (entry.run === run) entry.authRequired = true
      } catch (error) {
        if (!run.controller.signal.aborted && entry.run === run && !entry.authRequired) entry.lastError = String(error)
      } finally {
        if (entry.run === run || entry.run === undefined) entry.loading = false
      }
    })()
  }

  /**
   * Detach and tear down the current run. The abort lands first so in-flight
   * OAuth work dies, then the join waits for what it started: the fiber's
   * dispose releases the server-name reservation, so a successor may not fork
   * until this resolves.
   */
  async function stopRun(entry) {
    const run = entry.run
    if (run === undefined) return
    entry.run = undefined
    entry.loading = false
    run.controller.abort()
    // A bridge connect attempt that slips into the teardown window asks
    // `providerFor` after `entry.run` is gone; leaving the aborted provider
    // reachable makes that attempt fail fast instead of running bare.
    entry.lastProvider = run.provider
    try {
      await run.callback?.close()
    } catch {}
    await Promise.allSettled([run.work, Promise.resolve(run.fork?.dispose?.())])
  }

  function exchange(entry, run, authorizationCode) {
    return sdk.auth(run.provider, {
      serverUrl: entry.url,
      authorizationCode,
      fetchFn: run.provider.fetch,
    })
  }

  async function settle(entry, run, pending) {
    let authorized = run.preAuthorized
    try {
      if (!authorized) {
        const result = await run.callback.settled
        await run.callback.close()
        run.controller.signal.throwIfAborted()
        if (result.code === undefined) throw new Error(result.error)
        await exchange(entry, run, result.code)
        run.controller.signal.throwIfAborted()
        authorized = true
        if (entry.run === run) {
          entry.hadTokens = true
          entry.authRequired = false
        }
      }
      await connect(entry, run, true)
      return { state: stateOf(entry) }
    } catch (error) {
      if (run.controller.signal.aborted) return { error: "cancelled" }
      if (entry.run === run) {
        entry.lastError = String(error)
        // A failure before the connect attempt leaves the grant unserviceable:
        // report it as needing authorization rather than as an outage.
        if (!authorized) entry.authRequired = true
      }
      return { state: stateOf(entry), error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (run.pending === pending) run.pending = undefined
    }
  }

  function buildEntry(definition) {
    const accepted = assertServer(definition)
    return {
      ...accepted,
      store: createGrantStore(credentials, { serverName: accepted.serverName, serverUrl: accepted.url }),
      lane: Promise.resolve(),
      closed: false,
      run: undefined,
      lastProvider: undefined,
      loading: false,
      authRequired: false,
      hadTokens: false,
      lastError: undefined,
    }
  }

  function stateOf(entry) {
    if (entry.loading) return SERVER_STATE.CONNECTING
    if (entry.authRequired) return entry.hadTokens ? SERVER_STATE.EXPIRED : SERVER_STATE.UNAUTHORIZED
    if (entry.lastError !== undefined) return SERVER_STATE.DISCONNECTED
    if (entry.run?.connected === true) return SERVER_STATE.CONNECTED
    return SERVER_STATE.UNAUTHORIZED
  }

  return {
    async configure(definitions) {
      const accepted = definitions.map(assertServer)
      if (new Set(accepted.map((server) => server.serverName)).size !== accepted.length) {
        throw new Error("mcp-oauth: duplicate serverName in the server list")
      }
      const stale = new Map(entries)
      // Stale teardowns are queued on their own lanes first: a successor entry
      // inherits its predecessor's lane, so its load can never overlap the
      // server-name reservation the previous run has not released yet.
      const teardowns = [...stale.values()].map((entry) =>
        enqueue(entry, async () => {
          entry.closed = true
          await stopRun(entry)
          if (entries.get(entry.serverName) === entry) entries.delete(entry.serverName)
        }),
      )
      // Entries go into the map and their loads onto the lanes before the first
      // await, so an operation landing mid-load finds the entry and queues
      // behind the load rather than interleaving with it.
      const loads = accepted.map((definition) => {
        const entry = buildEntry(definition)
        const held = stale.get(entry.serverName)
        if (held !== undefined) entry.lane = held.lane
        entries.set(entry.serverName, entry)
        let work
        const queued = enqueue(entry, () => {
          if (disposed || entry.closed) return
          const run = createRun(entry)
          startLoad(entry, run, false)
          work = run.work
        })
        return queued.then(() => work)
      })
      await Promise.all(teardowns)
      if (disposed) return this.status()
      await Promise.all(loads)
      return this.status()
    },
    async add(definition) {
      if (disposed) throw new Error("mcp-oauth: engine is disposed")
      const accepted = assertServer(definition)
      const held = entries.get(accepted.serverName)
      if (held !== undefined) {
        if (!held.closed) throw new Error("mcp-oauth: server " + accepted.serverName + " is already configured")
        await held.lane.catch(() => {})
        // A racing add may have replaced the drained entry while we waited.
        if (entries.get(accepted.serverName) === held) entries.delete(accepted.serverName)
        else if (entries.has(accepted.serverName)) throw new Error("mcp-oauth: server " + accepted.serverName + " is already configured")
      }
      const entry = buildEntry(accepted)
      entries.set(entry.serverName, entry)
      let work
      await enqueue(entry, async () => {
        try {
          list.add(accepted)
        } catch (error) {
          entry.closed = true
          if (entries.get(entry.serverName) === entry) entries.delete(entry.serverName)
          throw error
        }
        if (disposed || entry.closed) {
          if (entries.get(entry.serverName) === entry) entries.delete(entry.serverName)
          return
        }
        const run = createRun(entry)
        startLoad(entry, run, true)
        work = run.work
      })
      await work
      return this.status()
    },
    async remove(serverName) {
      if (disposed) throw new Error("mcp-oauth: engine is disposed")
      const entry = entries.get(serverName)
      if (entry === undefined) {
        list.remove(serverName)
        return this.status()
      }
      await enqueue(entry, async () => {
        // A successor entry may already own this name: a queued op that lost
        // the slot must not touch its file entry, grant or map slot.
        if (entries.get(serverName) !== entry) return
        // The file is the restart authority, so it leaves first: a teardown
        // that then fails is retried from the same state the file still shows.
        list.remove(serverName)
        entry.closed = true
        await stopRun(entry)
        await entry.store.clear()
        if (entries.get(serverName) === entry) entries.delete(serverName)
      })
      return this.status()
    },
    providerFor(config) {
      const entry = entries.get(config.serverName)
      if (entry === undefined || config.transport !== "streamable-http" || config.url !== entry.url) return undefined
      return entry.run?.provider ?? entry.lastProvider
    },
    status() {
      return {
        servers: [...entries.values()].filter((entry) => !entry.closed).map((entry) => ({
          serverName: entry.serverName,
          url: entry.url,
          state: stateOf(entry),
          authorizationPending: entry.run?.pending !== undefined,
          lastError: entry.lastError,
        })),
        fileError: list.fileError(),
      }
    },
    authorize(serverName) {
      const entry = must(serverName)
      return enqueue(entry, async () => {
        if (entry.closed) throw gone(serverName)
        if (entry.run?.pending !== undefined) return { started: entry.run.pending.started }
        if (stateOf(entry) === SERVER_STATE.CONNECTED) {
          throw new Error("mcp-oauth: " + entry.serverName + " is already authorized; sign out before authorizing again")
        }
        await stopRun(entry)
        const run = createRun(entry)
        const pending = { state: randomBytes(16).toString("hex"), started: undefined, completion: undefined, authorizationUrl: undefined }
        run.pending = pending
        entry.lastError = undefined
        pending.started = (async () => {
          try {
            run.controller.signal.throwIfAborted()
            await entry.store.update({ tokens: undefined, codeVerifier: undefined }, run.controller.signal)
            run.callback = await startCallbackServer({ state: pending.state })
            run.controller.signal.throwIfAborted()
            run.controller.signal.addEventListener("abort", () => void run.callback.close(), { once: true })
            run.redirectUrl = run.callback.redirectUrl
            const outcome = await exchange(entry, run)
            run.controller.signal.throwIfAborted()
            if (outcome === "AUTHORIZED") {
              run.preAuthorized = true
              await run.callback.close()
            } else {
              if (pending.authorizationUrl === undefined) throw new Error("mcp-oauth: the authorization server returned no URL to open")
              const scheme = new URL(pending.authorizationUrl).protocol
              if (scheme !== "https:" && scheme !== "http:") {
                throw new Error("mcp-oauth: the authorization server returned a non-web URL (" + scheme + ")")
              }
            }
            pending.completion = settle(entry, run, pending)
            return { authorizationUrl: pending.authorizationUrl, completion: pending.completion }
          } catch (error) {
            await Promise.resolve(run.callback?.close()).catch(() => {})
            if (run.pending === pending) run.pending = undefined
            if (!run.controller.signal.aborted && entry.run === run) {
              entry.lastError = String(error)
              entry.authRequired = true
            }
            throw error
          }
        })()
        run.work = pending.started.then(
          ({ completion }) => Promise.resolve(completion).then(
            () => undefined,
            () => undefined,
          ),
          () => undefined,
        )
        return { started: pending.started }
      }).then(({ started }) => started)
    },
    async signOut(serverName) {
      const entry = must(serverName)
      await enqueue(entry, async () => {
        await stopRun(entry)
        await entry.store.clear()
        entry.authRequired = false
        entry.hadTokens = false
        entry.lastError = undefined
      })
      return this.status()
    },
    async retry(serverName) {
      const entry = must(serverName)
      let work
      await enqueue(entry, async () => {
        if (entry.closed) throw gone(serverName)
        await stopRun(entry)
        entry.lastError = undefined
        const run = createRun(entry)
        startLoad(entry, run, true)
        work = run.work
      })
      await work
      return this.status()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.all(
        [...entries.values()].map((entry) =>
          enqueue(entry, async () => {
            entry.closed = true
            await stopRun(entry)
          }),
        ),
      )
    },
  }
}
