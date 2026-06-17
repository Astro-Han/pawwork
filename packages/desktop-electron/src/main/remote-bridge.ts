import { createApp, type Config, type PlatformFactory } from "@opencode-ai/remote-bridge/gateway"
import {
  captureFirstSender,
  type CapturedSender,
  TelegramPlatform,
  TelegramPoller,
} from "@opencode-ai/remote-bridge/platforms/telegram"
import type { Platform } from "@opencode-ai/remote-bridge/types"
import type { RemotePairingResult, RemoteStatus } from "@opencode-ai/app/desktop-api"

export type { RemotePairingResult, RemoteStatus } from "@opencode-ai/app/desktop-api"

// Bounds how long a disconnect / quit waits for the bridge to stop, so a wedged
// long-poll can never block app shutdown. The poll fetch is aborted on stop, so
// this is just a backstop.
const STOP_TIMEOUT_MS = 3_000

export interface RemoteCredentials {
  token: string
  allowFrom: string
  /** Display name of the paired user, for the settings page; non-secret. */
  userName?: string
}

/** Persistence seam for the secret credentials (safeStorage-backed in prod). */
export interface CredentialStore {
  load(): RemoteCredentials | null
  save(creds: RemoteCredentials): void
  clear(): void
}

/** Raised when pairing is aborted (the connect dialog was closed) rather than
 * failing — lets the IPC layer distinguish a cancel from a real error. */
export class PairingCancelledError extends Error {
  constructor() {
    super("pairing cancelled")
    this.name = "PairingCancelledError"
  }
}

interface ServerInfo {
  url: string
  // The desktop's ServerReadyData uses null for "no auth"; normalized to
  // undefined when building the bridge config.
  username?: string | null
  password?: string | null
}

/** A runnable bridge, as the runtime needs it (`createApp`'s `App` satisfies it). */
interface BridgeApp {
  run(signal?: AbortSignal): Promise<void>
}

export interface RemoteBridgeDeps {
  credentials: CredentialStore
  statePath: string
  serverInfo: () => Promise<ServerInfo>
  // Injected so the lifecycle can be tested without Electron or a live network.
  buildApp: (config: Config, factory: PlatformFactory) => Promise<BridgeApp>
  makePoller: (token: string) => TelegramPoller
  capture: (poller: TelegramPoller, signal: AbortSignal) => Promise<CapturedSender | null>
  makePlatform: (token: string, allowFrom: string) => Platform
}

/**
 * Owns the single in-process bridge for the desktop app. Every lifecycle change
 * (connect / confirm-pairing / disconnect / shutdown) runs through one serial
 * queue so a double-click can never start two pollers on the same token. The
 * bridge runs in the background — its failures land in `status`, never as an
 * unhandled rejection. Pairing (capturing the first sender before an allow_from
 * exists) runs on its own poller and is always torn down before the real bridge
 * starts, since two pollers on one token race a 409.
 */
export class RemoteBridgeRuntime {
  private status: RemoteStatus = { state: "disconnected", platform: null, identity: null, error: null }
  private readonly listeners = new Set<(status: RemoteStatus) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private ac: AbortController | null = null
  private runPromise: Promise<void> | null = null
  private pairingAc: AbortController | null = null
  // The captured-but-not-yet-approved pairing. Holds the token main-side between
  // startPairing and confirmPairing so the renderer never has to resend the secret.
  private pending: { token: string; allowFrom: string; userName?: string } | null = null

  constructor(private readonly deps: RemoteBridgeDeps) {}

  getStatus(): RemoteStatus {
    return this.status
  }

  onStatusChange(listener: (status: RemoteStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Start the bridge on launch if a connection was previously saved. Failures
   * become degraded status, never a thrown error that breaks app startup. */
  async startIfConfigured(): Promise<void> {
    const creds = this.deps.credentials.load()
    if (!creds) return
    // startBridge sets degraded on any failure; this catch only keeps the
    // background start from surfacing as an unhandled rejection.
    await this.enqueue(() => this.startBridge(creds)).catch(() => {})
  }

  /**
   * Validate the token, then wait for the first private message so we learn who
   * to pair with. Blocks until a sender is captured; throws PairingCancelledError
   * if `cancelPairing` aborts it first. Does not persist anything — that is
   * `confirmPairing`'s job once the user approves the captured identity.
   */
  async startPairing(token: string): Promise<RemotePairingResult> {
    token = token.trim()
    if (token === "") throw new Error("a bot token is required")
    if (this.status.state === "connected" || this.status.state === "connecting") {
      throw new Error("disconnect the current account before pairing a new one")
    }
    this.pairingAc?.abort()
    this.pending = null
    const ac = new AbortController()
    this.pairingAc = ac
    const poller = this.deps.makePoller(token)
    let botUsername: string | undefined
    try {
      botUsername = (await poller.getMe(ac.signal)).username
    } catch (err) {
      // Cancelled (cancelPairing/disconnect) or superseded by a newer startPairing
      // while we awaited: surface a cancel and leave the current handle alone — it
      // belongs to whoever replaced us.
      if (ac.signal.aborted || this.pairingAc !== ac) throw new PairingCancelledError()
      this.pairingAc = null
      throw new Error(`could not reach Telegram with that token: ${message(err)}`)
    }
    const captured = await this.deps.capture(poller, ac.signal)
    // Same guard after capture: if this attempt was cancelled or superseded while
    // we waited, drop the result — never resurrect `pending` for an abandoned
    // attempt, even if a sender did arrive.
    if (ac.signal.aborted || this.pairingAc !== ac) throw new PairingCancelledError()
    this.pairingAc = null
    if (!captured) throw new PairingCancelledError()
    // Hold the token main-side; confirmPairing approves this identity without the
    // renderer resending the secret.
    this.pending = { token, allowFrom: captured.userId, userName: captured.userName }
    return { userId: captured.userId, userName: captured.userName, botUsername }
  }

  cancelPairing(): void {
    this.pairingAc?.abort()
    this.pairingAc = null
    this.pending = null
  }

  /**
   * Approve the pending pairing and start the bridge. The token was captured
   * main-side by `startPairing`, so the renderer approves the captured identity
   * without ever resending the secret.
   */
  async confirmPairing(): Promise<void> {
    const pending = this.pending
    if (!pending) throw new Error("no pairing is awaiting confirmation")
    this.pending = null
    await this.enqueue(async () => {
      await this.stopBridge()
      const creds: RemoteCredentials = { ...pending }
      this.deps.credentials.save(creds)
      await this.startBridge(creds)
    })
  }

  /** Stop the bridge and wipe the saved credentials. */
  async disconnect(): Promise<void> {
    this.cancelPairing()
    await this.enqueue(async () => {
      await this.stopBridge()
      this.deps.credentials.clear()
      this.setStatus({ state: "disconnected", platform: null, identity: null, error: null })
    })
  }

  /** Idempotent stop for app shutdown — does NOT clear credentials. */
  async stop(): Promise<void> {
    this.cancelPairing()
    await this.enqueue(() => this.stopBridge())
  }

  private async startBridge(creds: RemoteCredentials): Promise<void> {
    await this.stopBridge()
    this.setStatus({ state: "connecting", platform: "telegram", error: null })
    let app: BridgeApp
    try {
      const server = await this.deps.serverInfo()
      const config: Config = {
        pawWorkBaseURL: server.url,
        pawWorkUsername: server.username ?? undefined,
        pawWorkPassword: server.password ?? undefined,
        statePath: this.deps.statePath,
        platforms: [{ name: "telegram", enabled: true, options: { allow_from: creds.allowFrom } }],
      }
      // The token is captured in the factory closure, never placed in `config`
      // (which may be logged): only the non-secret allow_from travels through it.
      const factory: PlatformFactory = (name, options) => {
        if (name !== "telegram") throw new Error(`unsupported platform ${name}`)
        return this.deps.makePlatform(creds.token, String(options.allow_from ?? ""))
      }
      app = await this.deps.buildApp(config, factory)
    } catch (err) {
      // serverInfo / buildApp failed before the bridge ever ran. Land on degraded
      // so confirmPairing — which awaits this directly, unlike startIfConfigured —
      // can't leave the status stuck on "connecting" forever when the build throws.
      this.setStatus({ state: "degraded", error: message(err) })
      throw err
    }
    const ac = new AbortController()
    this.ac = ac
    const run = app.run(ac.signal)
    this.runPromise = run
    // run() resolves on a clean stop and rejects on a fatal failure (revoked
    // token, stream protocol error). Observe it so a failure becomes degraded
    // status rather than an unhandled rejection. The `this.ac === ac` guard
    // keeps a stale run from clobbering a newer connection's status.
    run
      .then(() => {
        if (this.ac === ac) this.setStatus({ state: "disconnected", platform: null, identity: null })
      })
      .catch((err) => {
        if (this.ac === ac) this.setStatus({ state: "degraded", error: message(err) })
      })
    this.setStatus({
      state: "connected",
      identity: { userId: creds.allowFrom, userName: creds.userName ?? creds.allowFrom },
    })
  }

  private async stopBridge(): Promise<void> {
    const ac = this.ac
    const runPromise = this.runPromise
    this.ac = null
    this.runPromise = null
    if (!ac) return
    ac.abort()
    if (runPromise) {
      await Promise.race([runPromise.catch(() => {}), delay(STOP_TIMEOUT_MS)])
    }
  }

  private setStatus(patch: Partial<RemoteStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) {
      try {
        listener(this.status)
      } catch {
        // a listener failure must not break status propagation
      }
    }
  }

  // Serialize lifecycle ops so concurrent calls (e.g. a double-clicked button)
  // never run two startBridge/stopBridge sequences at once.
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

/** Wire a runtime with the real remote-bridge implementation. */
export function createRemoteBridgeRuntime(deps: {
  credentials: CredentialStore
  statePath: string
  serverInfo: () => Promise<ServerInfo>
}): RemoteBridgeRuntime {
  return new RemoteBridgeRuntime({
    ...deps,
    buildApp: createApp,
    makePoller: (token) => new TelegramPoller(token),
    capture: captureFirstSender,
    makePlatform: (token, allowFrom) => new TelegramPlatform({ token, allowFrom }),
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
