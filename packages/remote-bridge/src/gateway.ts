import { readFile } from "node:fs/promises"
import { Engine } from "./engine.ts"
import { normalizeLocale, type Locale } from "./i18n.ts"

// Re-exported so the desktop runtime can normalize its UI locale into Config.locale.
export { normalizeLocale }
import { isFatalStreamError, PawWorkClient } from "./pawwork-client.ts"
import type { EventHandler } from "./pawwork-events.ts"
import { SessionPointers } from "./session-pointers.ts"
import type { MessageHandler, Platform } from "./types.ts"

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

  const platforms: Platform[] = []
  for (const item of config.platforms ?? []) {
    if (!item.enabled) continue
    if (!item.name) throw new Error("enabled platform name is required")
    const options = item.options ?? {}
    if (!hasRemoteAudience(item.name, options)) {
      throw new Error(`${item.name} platform requires a specific allow_from or Feishu/Lark allow_chat with group_only`)
    }
    const platform = await createPlatform(item.name, options)
    engine.registerPlatform(platform)
    platforms.push(platform)
  }
  if (platforms.length === 0) throw new Error("at least one platform must be enabled")

  return new App({ client, engine, platforms })
}

// Bounds the warm-up scan on startup and reconnect. Parent links come from the
// persisted pointer store and live event replay, so the scan only needs the
// most recently active sessions, not the full history.
export const hydrateSessionLimit = 100

export class App {
  private readonly client: PawWorkClient
  private readonly engine: Engine
  private readonly platforms: Platform[]
  /** Base backoff between event-stream reconnect attempts; lowered in tests. */
  eventRetryDelayMs = 1000

  constructor(opts: { client: PawWorkClient; engine: Engine; platforms: Platform[]; eventRetryDelayMs?: number }) {
    this.client = opts.client
    this.engine = opts.engine
    this.platforms = opts.platforms
    if (opts.eventRetryDelayMs !== undefined) this.eventRetryDelayMs = opts.eventRetryDelayMs
  }

  platformNames(): string[] {
    return this.platforms.map((platform) => platform.name)
  }

  /**
   * Connect the event stream, wait until it is ready, do the initial hydrate,
   * then start the platforms — in that order, so no inbound message is handled
   * before pending state is loaded. Returns when `signal` aborts; rejects on a
   * fatal stream error or a platform failure. Ported from Go `App.Run`.
   */
  async run(signal?: AbortSignal): Promise<void> {
    const ac = new AbortController()
    if (signal?.aborted) ac.abort()
    const onParentAbort = () => ac.abort()
    signal?.addEventListener("abort", onParentAbort, { once: true })
    const childSignal = ac.signal

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

      // Errors from a platform's start() route to `failure` inside startPlatforms.
      // Like Go's Run, stay up until abort or a fatal error even if every
      // platform's start() resolves on its own — a clean self-stop is not a reason
      // to tear the bridge down.
      this.startPlatforms(childSignal, failure)
      await Promise.race([onAbort(childSignal), failure.promise])
    } catch (err) {
      // An abort is a requested stop, not a failure: any error it triggered
      // mid-hydrate or mid-stream is swallowed, matching Go's `<-ctx.Done()`.
      if (childSignal.aborted) return
      throw err
    } finally {
      ac.abort()
      signal?.removeEventListener("abort", onParentAbort)
      await this.stopPlatforms()
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

  /** Forward inbound chat messages to the engine, logging handler failures. */
  messageHandler(): MessageHandler {
    return (platform, msg) => {
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

  private startPlatforms(signal: AbortSignal, failure: Deferred<never>): Promise<void>[] {
    const handler = this.messageHandler()
    return this.platforms.map((platform) =>
      Promise.resolve()
        .then(() => platform.start(handler))
        .then(
          () => {},
          (err) => {
            if (!signal.aborted) failure.reject(new Error(`${platform.name} platform failed: ${message(err)}`))
          },
        ),
    )
  }

  private async stopPlatforms(): Promise<void> {
    await Promise.all(this.platforms.map((platform) => platform.stop().catch(() => {})))
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
