import { readFile } from "node:fs/promises"
import { Engine } from "./engine.ts"
import { normalizeLocale, type Locale } from "./i18n.ts"

// Re-exported so the desktop runtime can normalize its UI locale into Config.locale.
export { normalizeLocale }
import { isFatalStreamError, PawWorkClient } from "./pawwork-client.ts"
import type { EventHandler } from "./pawwork-events.ts"
import { SessionPointers } from "./session-pointers.ts"
import { PlatformSupervisor, type PlatformStatus } from "./supervisor.ts"
import type { MessageHandler, Platform } from "./types.ts"

// Re-exported so the desktop runtime can render per-channel connection status.
export type { PlatformStatus }

export interface PlatformConfig {
  name: string
  enabled: boolean
  options?: Record<string, unknown>
}

export interface Config {
  pawWorkBaseURL: string
  pawWorkUsername?: string
  pawWorkPassword?: string
  statePath: string
  /** Language for the chat-facing copy; defaults to English when unset. */
  locale?: Locale
  platforms: PlatformConfig[]
}

/** Builds a live platform from its name + options. The Lark/Chat-SDK adapter is
 * injected here so the gateway stays testable with fakes. Mirrors Go's global
 * `core.CreatePlatform`, but as an explicit dependency rather than a registry. */
export type PlatformFactory = (name: string, options: Record<string, unknown>) => Platform | Promise<Platform>

export function decodeConfig(text: string): Config {
  return JSON.parse(text) as Config
}

export async function loadConfig(path: string): Promise<Config> {
  return decodeConfig(await readFile(path, "utf8"))
}

/**
 * Whether a platform's options name a specific remote audience. A bridge that
 * answers anyone is a security hole, so a wildcard or empty audience is refused.
 * Feishu/Lark additionally require a named group chat with group_only.
 */
export function hasRemoteAudience(platform: string, options: Record<string, unknown>): boolean {
  const allowFrom = options.allow_from
  if (typeof allowFrom === "string" && isSpecificAudience(allowFrom)) return true
  if (platform !== "feishu" && platform !== "lark") return false
  const allowChat = options.allow_chat
  return typeof allowChat === "string" && isSpecificAudience(allowChat) && options.group_only === true
}

function isSpecificAudience(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== "" && trimmed !== "*"
}

/**
 * Wire a PawWork client, engine, file-backed pointers, and the enabled
 * platforms (each audience-gated) into a runnable App. Ported from Go `New`.
 */
export async function createApp(config: Config, createPlatform: PlatformFactory): Promise<App> {
  if (!config.pawWorkBaseURL) throw new Error("pawWorkBaseURL is required")
  if (!config.statePath) throw new Error("statePath is required")

  const pointers = await SessionPointers.fromFile(config.statePath)
  const client = new PawWorkClient({
    baseURL: config.pawWorkBaseURL,
    username: config.pawWorkUsername,
    password: config.pawWorkPassword,
  })
  client.setEventCursorStore(pointers)
  const engine = new Engine(client, pointers, normalizeLocale(config.locale))

  const app = new App({ client, engine, pointers, factory: createPlatform })
  for (const item of config.platforms ?? []) {
    if (!item.enabled) continue
    await app.addPlatform(item)
  }
  if (app.platformNames().length === 0) throw new Error("at least one platform must be enabled")

  return app
}

// Bounds the warm-up scan on startup and reconnect. Parent links come from the
// persisted pointer store and live event replay, so the scan only needs the
// most recently active sessions, not the full history.
export const hydrateSessionLimit = 100

/**
 * Thrown by addPlatform / removePlatform when the shared event stream went fatal and the
 * App is tearing down, so the incremental change could not be applied to a live bridge.
 * The persisted account set is authoritative, so the caller recovers by rebuilding the
 * bridge from it rather than trusting a change that silently did not take effect.
 */
export class BridgeClosedError extends Error {
  constructor(platform: string) {
    super(`remote bridge is closed; cannot apply change to ${platform}`)
    this.name = "BridgeClosedError"
  }
}

export class App {
  private readonly client: PawWorkClient
  private readonly engine: Engine
  private readonly pointers: SessionPointers
  private readonly factory: PlatformFactory
  /** The live platform set and source of truth for "which platforms should run".
   * Built eagerly (a constructed-but-unstarted platform holds no resources); the
   * supervisor mirrors this set once run() brings it up. */
  private readonly desiredPlatforms = new Map<string, Platform>()
  /** Set after the event stream is up; null before run() and after teardown. */
  private supervisor: PlatformSupervisor | null = null
  /** True once run() has begun tearing down (fatal stream or abort). Distinguishes a
   * null supervisor during teardown (incremental ops must fail) from one during startup
   * (the platform is adopted by run()'s initial snapshot). Set in the same synchronous
   * step as `supervisor = null`, so the two are never observed out of agreement. */
  private tearingDown = false
  /** Base backoff between event-stream reconnect attempts; lowered in tests. */
  eventRetryDelayMs = 1000
  /** Base backoff before restarting a failed platform; lowered in tests. */
  platformRetryDelayMs = 1000

  constructor(opts: {
    client: PawWorkClient
    engine: Engine
    pointers: SessionPointers
    factory: PlatformFactory
    eventRetryDelayMs?: number
    platformRetryDelayMs?: number
  }) {
    this.client = opts.client
    this.engine = opts.engine
    this.pointers = opts.pointers
    this.factory = opts.factory
    if (opts.eventRetryDelayMs !== undefined) this.eventRetryDelayMs = opts.eventRetryDelayMs
    if (opts.platformRetryDelayMs !== undefined) this.platformRetryDelayMs = opts.platformRetryDelayMs
  }

  platformNames(): string[] {
    return [...this.desiredPlatforms.keys()]
  }

  /**
   * Add one platform to the live set (and start it if the bridge is already up).
   * Same gate as cold start: the audience is validated and the platform built via
   * the injected factory here in the gateway, so an incrementally-added channel
   * can never bypass the audience check. If a platform of the same name is already
   * live (a re-pair), the replacement is built first and the old loop retired only on
   * success — keeping its session pointers, since a re-pair continues the conversation
   * rather than forgetting it; a failed build leaves the old channel serving. The
   * optional `beforeCommit` hook runs at that same safe point — after the build, before
   * any live change — so a caller that must durably commit the new channel (the desktop
   * saves its credential) can fail there and still leave the old channel serving.
   * Registered with the Engine before it is supervised, so its first inbound routes.
   */
  async addPlatform(config: PlatformConfig, beforeCommit?: () => void | Promise<void>): Promise<void> {
    if (!config.name) throw new Error("enabled platform name is required")
    const options = config.options ?? {}
    if (!hasRemoteAudience(config.name, options)) {
      throw new Error(`${config.name} platform requires a specific allow_from or Feishu/Lark allow_chat with group_only`)
    }
    // Prepare-first / swap-after-success: validate the audience, build the replacement,
    // and run beforeCommit BEFORE touching any live same-name instance, so a failed
    // re-pair (rejected audience, a factory throw, or a beforeCommit that can't persist)
    // leaves the existing channel serving and lets the caller roll back without losing a
    // working connection. Only once all three succeed do we retire the old loop (keeping
    // its session pointers, since a re-pair continues the conversation), register the new
    // one, and supervise it.
    const platform = await this.factory(config.name, options)
    await beforeCommit?.()
    if (this.desiredPlatforms.has(config.name)) await this.retirePlatform(config.name)
    // Commit point. Every await above is a yield where the shared stream can go fatal and
    // tear the bridge down (tearingDown set, supervisor cleared). If that happened, the
    // live supervise below would silently no-op and we'd report success for a channel that
    // never starts — so fail loudly and let the caller rebuild from the persisted accounts.
    // A null supervisor during STARTUP is fine (tearingDown is false): the platform sits in
    // desiredPlatforms and run()'s initial snapshot adopts it. Since tearingDown and
    // supervisor=null are set in one synchronous teardown step, "tearingDown false + null
    // supervisor" only ever means startup, never teardown. No await below: the check and
    // the live swap are one atomic step.
    if (this.tearingDown) throw new BridgeClosedError(config.name)
    this.engine.registerPlatform(platform)
    this.desiredPlatforms.set(config.name, platform)
    this.supervisor?.add(platform)
  }

  /**
   * Disconnect one platform: retire its loop, then forget its persisted session
   * pointers, so a later reconnect of the same platform starts fresh. The shared
   * event stream and the other platforms keep running.
   */
  async removePlatform(name: string): Promise<void> {
    await this.retirePlatform(name)
    // The retire is the commit: the channel has stopped serving and left routing, so the
    // disconnect is durably done. Forgetting its session pointers is best-effort cleanup (a
    // later reconnect starts fresh), so a failed pointer write is logged and swallowed, not
    // thrown — a thrown cleanup error would surface as a failed disconnect and strand the
    // caller's UI showing a channel that has already stopped. A stale on-disk pointer
    // self-heals on the next pointer save and is never resurfaced by a live channel.
    try {
      await this.pointers.clearPlatform(name)
    } catch (err) {
      console.warn("remote bridge could not forget session pointers for a removed platform", {
        platform: name,
        error: message(err),
      })
    }
    // If the bridge tore down while we retired, the surviving channels went down with it —
    // signal the caller to rebuild them from the persisted accounts (which no longer include
    // this one).
    if (this.tearingDown) throw new BridgeClosedError(name)
  }

  /**
   * Stop one platform's loop and drop it from routing, leaving the shared event
   * stream and siblings running. Liveness and routing are invalidated synchronously
   * (so a late inbound from this instance is dropped before the async stop), then
   * the loop is aborted, stopped, and awaited. Shared by disconnect (removePlatform,
   * which also forgets pointers) and re-pair (addPlatform, which keeps them).
   */
  private async retirePlatform(name: string): Promise<void> {
    this.desiredPlatforms.delete(name)
    this.engine.unregisterPlatform(name)
    await this.supervisor?.remove(name)
  }

  /**
   * Connect the event stream, wait until it is ready, do the initial hydrate,
   * then start the platforms — in that order, so no inbound message is handled
   * before pending state is loaded. Returns when `signal` aborts; rejects only on
   * a fatal stream error. A single platform's failure is isolated and retried by
   * the supervisor (surfaced through `onStatus`), never fatal. Ported from Go
   * `App.Run`, with per-platform supervision added.
   */
  async run(signal?: AbortSignal, onReady?: () => void, onStatus?: (status: PlatformStatus) => void): Promise<void> {
    const ac = new AbortController()
    if (signal?.aborted) ac.abort()
    const onParentAbort = () => ac.abort()
    signal?.addEventListener("abort", onParentAbort, { once: true })
    const childSignal = ac.signal

    // `failure` is the fatal stream path only: a dead PawWork event stream tears
    // the bridge down. A dead platform does not — the supervisor isolates it.
    const failure = createDeferred<never>()
    // Observe early so a failure before any race sees it is never "unhandled".
    failure.promise.catch(() => {})
    const ready = createDeferred<void>()
    let readyResolved = false

    const handler = this.streamHandler(childSignal, () => {
      if (!readyResolved) {
        readyResolved = true
        ready.resolve()
      }
    })
    const streamLoop = this.runEventStream(handler, childSignal, failure)

    try {
      const first = await Promise.race([
        ready.promise.then(() => "ready" as const),
        onAbort(childSignal).then(() => "aborted" as const),
        failure.promise,
      ])
      if (first === "aborted") return

      await this.hydrate(childSignal)

      // Fire onReady only once every platform present at cold start has drained
      // its backlog and is serving, so a caller's "connected" can't precede live
      // message delivery. The bar is frozen to this initial snapshot: a channel
      // added later (incremental connect) reports its own status but never moves
      // the cold-start gate. A platform's failure is isolated and retried by the
      // supervisor — it never routes to `failure`, so one dead channel cannot tear
      // the bridge down.
      const initialPlatforms = [...this.desiredPlatforms.values()]
      const initialNames = new Set(initialPlatforms.map((platform) => platform.name))
      const readyNames = new Set<string>()
      const allReady = createDeferred<void>()
      if (initialNames.size === 0) allReady.resolve()
      const onPlatformReady = (platform: Platform) => {
        if (!initialNames.has(platform.name) || readyNames.has(platform.name)) return
        readyNames.add(platform.name)
        if (readyNames.size >= initialNames.size) allReady.resolve()
      }
      void Promise.race([allReady.promise, onAbort(childSignal)]).then(() => {
        if (!childSignal.aborted) onReady?.()
      })

      // Create the supervisor, then seed it synchronously from the live set — no
      // await in between, so an incremental addPlatform can't interleave and
      // double-add. Once it exists, add/removePlatform drive it directly.
      const supervisor = new PlatformSupervisor(this.messageHandler(), childSignal, {
        onPlatformReady,
        onStatus,
        backoffMs: this.platformRetryDelayMs,
      })
      this.supervisor = supervisor
      for (const platform of initialPlatforms) supervisor.add(platform)
      await Promise.race([onAbort(childSignal), failure.promise])
    } catch (err) {
      // An abort is a requested stop, not a failure: any error it triggered
      // mid-hydrate or mid-stream is swallowed, matching Go's `<-ctx.Done()`.
      if (childSignal.aborted) return
      throw err
    } finally {
      ac.abort()
      signal?.removeEventListener("abort", onParentAbort)
      // Stop every supervised platform (unblocks any start() its loop is awaiting)
      // and let the loops wind down. If the run aborted during connect/hydrate the
      // supervisor never came up; the built-but-unstarted platforms hold no
      // resources, but stop() them too for symmetry.
      const supervisor = this.supervisor
      // Set together, in this one synchronous step, so an incremental op awaiting across
      // teardown sees both: tearingDown true means "fail loudly", not a startup null.
      this.supervisor = null
      this.tearingDown = true
      if (supervisor) await supervisor.stopAll()
      else await this.stopUnstartedPlatforms()
      await streamLoop
    }
  }

  /** Re-list sessions, permissions, and questions and feed them to the engine.
   * A missing session link aborts (it would corrupt routing); a prompt that
   * cannot be delivered is logged and skipped, never held. Ported from Go `hydrate`. */
  async hydrate(signal?: AbortSignal): Promise<void> {
    const sessions = await this.client.listSessions(hydrateSessionLimit, signal)
    for (const session of sessions) await this.engine.handleSession(session)

    const permissions = await this.client.listPermissions(signal)
    for (const permission of permissions) {
      try {
        await this.engine.handlePermission(permission)
      } catch (err) {
        console.warn("remote bridge could not resurface pending permission", {
          session: permission.sessionID,
          permission: permission.id,
          error: message(err),
        })
      }
    }

    const questions = await this.client.listQuestions(signal)
    for (const question of questions) {
      try {
        await this.engine.handleQuestion(question)
      } catch (err) {
        console.warn("remote bridge could not resurface pending question", {
          session: question.sessionID,
          message: question.messageID,
          error: message(err),
        })
      }
    }
  }

  /** Forward inbound chat messages to the engine, logging handler failures.
   * Drops an inbound from a platform that is no longer the live instance for its
   * name (removed, or replaced by a re-pair): the gateway owns the live set, so a
   * stale loop's in-flight message can't create a session or send a prompt. */
  messageHandler(): MessageHandler {
    return (platform, msg) => {
      if (this.desiredPlatforms.get(platform.name) !== platform) return
      this.engine.handleMessage(platform, msg).catch((err) =>
        console.warn("remote bridge failed to handle inbound message", {
          platform: platform.name,
          sessionKey: msg.sessionKey,
          error: message(err),
        }),
      )
    }
  }

  private streamHandler(signal: AbortSignal, signalReady: () => void): EventHandler {
    const engine = this.engine
    return {
      handleAssistantText: (sessionID, text) => engine.handleAssistantText(sessionID, text),
      handlePermission: (permission) => engine.handlePermission(permission),
      handlePermissionResolved: (resolution) => engine.handlePermissionResolved(resolution),
      handleQuestion: (question) => engine.handleQuestion(question),
      handleQuestionResolved: (resolution) => engine.handleQuestionResolved(resolution),
      handleSession: (session) => engine.handleSession(session),
      handleReplayRefresh: () => this.hydrate(signal),
      handleStreamReady: async () => {
        signalReady()
      },
    }
  }

  private async runEventStream(handler: EventHandler, signal: AbortSignal, failure: Deferred<never>): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.client.streamEvents(handler, signal)
      } catch (err) {
        if (signal.aborted) return
        if (isFatalStreamError(err)) {
          failure.reject(err)
          return
        }
        console.warn("remote bridge event stream disconnected", message(err))
      }
      if (signal.aborted) return
      await sleep(this.eventRetryDelayMs, signal)
    }
  }

  private async stopUnstartedPlatforms(): Promise<void> {
    await Promise.all([...this.desiredPlatforms.values()].map((platform) => platform.stop().catch(() => {})))
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onSignal = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onSignal)
      resolve()
    }, ms)
    signal.addEventListener("abort", onSignal, { once: true })
  })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
