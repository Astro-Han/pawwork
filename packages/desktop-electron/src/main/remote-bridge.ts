import { rmSync } from "node:fs"
import { normalizeLocale, type Config, type PlatformFactory, type PlatformStatus } from "@opencode-ai/remote-bridge/gateway"
import type { Platform } from "@opencode-ai/remote-bridge/types"
import type {
  RemoteChannelStatus,
  RemotePairingEvent,
  RemotePairingStart,
  RemotePlatform,
  RemoteState,
  RemoteStatus,
} from "@opencode-ai/app/desktop-api"

export type { RemoteChannelStatus, RemotePairingEvent, RemotePairingStart, RemotePlatform, RemoteStatus }

// Bounds how long a disconnect / quit waits for the bridge to stop, so a wedged
// long-poll can never block app shutdown. The poll fetch is aborted on stop, so
// this is just a backstop.
const STOP_TIMEOUT_MS = 3_000

/**
 * A saved connection. One per platform — pairing a platform again replaces its
 * account. The secret (bot token) lives here and is never sent back over IPC.
 * A discriminated union so each new platform adds its own account shape here.
 */
export type RemoteAccount = { platform: "telegram"; token: string; allowFrom: string; userName?: string }

/** Persistence seam for the secret accounts (safeStorage-backed in prod). */
export interface CredentialStore {
  /** Whether secrets can actually be persisted (OS encryption is available).
   * Checked up front by startPairing so we never walk the user through pairing
   * only to fail at the final save. */
  isAvailable(): boolean
  load(): RemoteAccount[]
  save(accounts: RemoteAccount[]): void
  /** Delete the persisted accounts file. A removal needs no encryption, so a
   * disconnect can revoke access even when the OS keyring is locked — unlike
   * save([]), which would throw and leave the token on disk. */
  clear(): void
}

/** The progress a pairer reports while a scan-to-connect flow runs. The terminal
 * phases (captured / error / cancelled) are emitted by the runtime, uniformly. */
export type PairingProgress = (event: Extract<RemotePairingEvent, { phase: "awaitingBind" }>) => void

/**
 * One platform's connect logic, isolated so the runtime stays platform-agnostic.
 * `pair` runs the scan-to-connect flow (emitting bind progress) and resolves with
 * the account to save, or null if cancelled/aborted; a thrown error becomes a
 * pairing `error` event. The rest map a saved account onto the gateway: the live
 * `Platform`, the non-secret audience options, and the display identity.
 */
export interface PlatformPairer {
  readonly platform: RemotePlatform
  pair(start: RemotePairingStart, emit: PairingProgress, signal: AbortSignal): Promise<RemoteAccount | null>
  makePlatform(account: RemoteAccount): Platform
  audience(account: RemoteAccount): Record<string, unknown>
  identity(account: RemoteAccount): { id: string; name: string }
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
  run(signal?: AbortSignal, onReady?: () => void, onStatus?: (status: PlatformStatus) => void): Promise<void>
}

export interface RemoteBridgeDeps {
  credentials: CredentialStore
  statePath: string
  serverInfo: () => Promise<ServerInfo>
  /** The desktop UI language, for localizing the chat-facing copy. */
  locale: () => string
  // Injected so the lifecycle can be tested without Electron or a live network:
  // a fake buildApp and fake pairers exercise the whole runtime.
  buildApp: (config: Config, factory: PlatformFactory) => Promise<BridgeApp>
  pairers: PlatformPairer[]
}

/**
 * Owns the single in-process bridge for the desktop app. Several platforms can be
 * connected at once: they run under one `App` (the gateway supervises each in its
 * own restart loop) and report status independently — a dead channel shows
 * `degraded` while the others stay `connected`. Every lifecycle change (confirm /
 * disconnect / shutdown) runs through one serial queue so a double-click can never
 * start two bridges. Pairing runs off to the side on its own transport and is
 * always settled before the queue rebuilds the bridge. The bridge runs in the
 * background — its failures land in `status`, never as an unhandled rejection.
 */
export class RemoteBridgeRuntime {
  private accounts: RemoteAccount[] = []
  private readonly statusMap = new Map<RemotePlatform, RemoteChannelStatus>()
  private readonly statusListeners = new Set<(status: RemoteStatus) => void>()
  private readonly pairingListeners = new Set<(event: RemotePairingEvent) => void>()
  private readonly pairers = new Map<RemotePlatform, PlatformPairer>()
  private queue: Promise<unknown> = Promise.resolve()
  private ac: AbortController | null = null
  private runPromise: Promise<void> | null = null
  private pairingAc: AbortController | null = null
  // The captured-but-not-yet-approved account. Held main-side between the pairing
  // flow and confirmPairing so the renderer never has to resend the secret.
  private pending: RemoteAccount | null = null

  constructor(private readonly deps: RemoteBridgeDeps) {
    for (const pairer of deps.pairers) this.pairers.set(pairer.platform, pairer)
  }

  getStatus(): RemoteStatus {
    return { channels: [...this.statusMap.values()] }
  }

  onStatusChange(listener: (status: RemoteStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onPairing(listener: (event: RemotePairingEvent) => void): () => void {
    this.pairingListeners.add(listener)
    return () => this.pairingListeners.delete(listener)
  }

  /** Start the bridge on launch if any account was previously saved. Failures
   * become degraded status, never a thrown error that breaks app startup. */
  async startIfConfigured(): Promise<void> {
    this.accounts = this.deps.credentials.load()
    if (this.accounts.length === 0) return
    // startBridge sets degraded on any failure; this catch only keeps the
    // background start from surfacing as an unhandled rejection.
    await this.enqueue(() => this.startBridge()).catch(() => {})
  }

  /**
   * Run a platform's scan-to-connect flow. Event-driven: progress (QR, then the
   * bind hint) and the outcome (captured / error / cancelled) all arrive via
   * `onPairing` — this resolves void and never throws, so the IPC layer is a thin
   * pass-through. The captured account is held main-side; confirmPairing approves
   * it without the renderer ever resending the secret.
   */
  async startPairing(platform: RemotePlatform, start: RemotePairingStart = {}): Promise<void> {
    const pairer = this.pairers.get(platform)
    if (!pairer) return this.emitPairing({ phase: "error", platform, message: `unsupported platform ${platform}` })
    // Preflight secure storage before contacting the platform: without OS
    // encryption the credential can never be saved, so fail here rather than after
    // the user has scanned a QR and messaged the bot only for the final save to throw.
    if (!this.deps.credentials.isAvailable()) {
      return this.emitPairing({
        phase: "error",
        platform,
        message: "secure storage is unavailable on this system, so the credential cannot be saved",
      })
    }
    this.pairingAc?.abort()
    this.pending = null
    const ac = new AbortController()
    this.pairingAc = ac
    const emit: PairingProgress = (event) => {
      if (this.pairingAc === ac) this.emitPairing(event)
    }
    let account: RemoteAccount | null
    try {
      account = await pairer.pair(start, emit, ac.signal)
    } catch (err) {
      // Cancelled / superseded while we awaited: surface a cancel and leave the
      // current handle alone — it belongs to whoever replaced us. Otherwise the
      // flow hit a real failure (bad credential, unreachable platform).
      if (ac.signal.aborted || this.pairingAc !== ac) return this.emitPairing({ phase: "cancelled", platform })
      this.pairingAc = null
      return this.emitPairing({ phase: "error", platform, message: message(err) })
    }
    if (ac.signal.aborted || this.pairingAc !== ac) return this.emitPairing({ phase: "cancelled", platform })
    this.pairingAc = null
    if (!account) return this.emitPairing({ phase: "cancelled", platform })
    this.pending = account
    this.emitPairing({ phase: "captured", platform, identity: pairer.identity(account) })
  }

  cancelPairing(): void {
    const pending = this.pending
    this.pending = null
    if (this.pairingAc) {
      // An in-flight flow: aborting it makes pair() resolve null / throw, and that
      // path emits the cancelled event — don't double-emit here.
      this.pairingAc.abort()
      this.pairingAc = null
      return
    }
    // Already captured and awaiting confirmation: no flow to abort, so emit here.
    if (pending) this.emitPairing({ phase: "cancelled", platform: pending.platform })
  }

  /**
   * Approve the pending account for `platform` and (re)start the bridge with it.
   * The secret was captured main-side, so the renderer approves the captured
   * identity without resending it. Replaces any existing account for the platform.
   */
  async confirmPairing(platform: RemotePlatform): Promise<void> {
    const pending = this.pending
    if (!pending || pending.platform !== platform) throw new Error("no pairing is awaiting confirmation")
    this.pending = null
    await this.enqueue(async () => {
      this.accounts = [...this.accounts.filter((account) => account.platform !== platform), pending]
      this.deps.credentials.save(this.accounts)
      await this.startBridge()
    })
  }

  /** Remove one platform's account and rebuild the bridge from the rest. */
  async disconnect(platform: RemotePlatform): Promise<void> {
    if (this.pending?.platform === platform) this.cancelPairing()
    await this.enqueue(async () => {
      this.accounts = this.accounts.filter((account) => account.platform !== platform)
      this.statusMap.delete(platform)
      this.emitStatus()
      if (this.accounts.length === 0) {
        // Last channel gone. Stop the live bridge FIRST, then delete the secret
        // AND the bridge state file (session pointers + event cursor): tearing
        // down before the delete keeps an in-flight inbound handler from writing
        // pointers back after the file is gone, which a reconnect would inherit.
        // Deleting needs no encryption, so revoking works even when the keyring is
        // locked — save([]) would throw and leave the token behind.
        await this.stopBridge()
        this.deps.credentials.clear()
        rmSync(this.deps.statePath, { force: true })
        return
      }
      // A channel remains: persist the trimmed list and rebuild from the rest.
      // (Pruning just the disconnected platform's pointers from statePath lands
      // with the 2nd platform.)
      this.deps.credentials.save(this.accounts)
      await this.startBridge()
    })
  }

  /** Idempotent stop for app shutdown — does NOT clear saved accounts. */
  async stop(): Promise<void> {
    this.cancelPairing()
    // Abort the live bridge synchronously, before the first await. before-quit runs
    // `void stop(); killSidecar()` without awaiting, so the abort must land on this
    // sync prefix — otherwise the poll loop is still running against the sidecar
    // (the server it talks to) at the moment it is torn down. stopBridge re-aborts
    // (idempotent) and awaits the teardown.
    this.ac?.abort()
    await this.enqueue(() => this.stopBridge())
  }

  private async startBridge(): Promise<void> {
    await this.stopBridge()
    if (this.accounts.length === 0) return
    for (const account of this.accounts) {
      this.putChannel({ platform: account.platform, state: "connecting", identity: this.pairerFor(account).identity(account), error: null })
    }
    let app: BridgeApp
    try {
      const server = await this.deps.serverInfo()
      const config: Config = {
        pawWorkBaseURL: server.url,
        pawWorkUsername: server.username ?? undefined,
        pawWorkPassword: server.password ?? undefined,
        statePath: this.deps.statePath,
        locale: normalizeLocale(this.deps.locale()),
        // Only the non-secret audience travels through config (which may be logged);
        // the secret is captured in the factory closure below, never placed here.
        platforms: this.accounts.map((account) => ({
          name: account.platform,
          enabled: true,
          options: this.pairerFor(account).audience(account),
        })),
      }
      const factory: PlatformFactory = (name) => {
        const account = this.accounts.find((candidate) => candidate.platform === name)
        if (!account) throw new Error(`unsupported platform ${name}`)
        return this.pairerFor(account).makePlatform(account)
      }
      app = await this.deps.buildApp(config, factory)
    } catch (err) {
      // serverInfo / buildApp failed before the bridge ran. Land every account on
      // degraded so confirmPairing/disconnect — which await this directly — can't
      // leave status stuck on "connecting" when the build throws.
      for (const account of this.accounts) {
        this.putChannel({ platform: account.platform, state: "degraded", identity: this.pairerFor(account).identity(account), error: message(err) })
      }
      throw err
    }
    const ac = new AbortController()
    this.ac = ac
    // Per-platform status comes from the supervisor: each channel flips
    // connecting → connected as it drains its backlog and serves, or → degraded on
    // a failure it is retrying. The `this.ac === ac` guard keeps a stale run from
    // clobbering a newer build's status.
    const onStatus = (status: PlatformStatus) => {
      if (this.ac !== ac) return
      const account = this.accounts.find((candidate) => candidate.platform === status.name)
      if (!account) return
      const state: RemoteState = status.phase === "serving" ? "connected" : status.phase === "degraded" ? "degraded" : "connecting"
      this.putChannel({ platform: account.platform, state, identity: this.pairerFor(account).identity(account), error: status.error ?? null })
    }
    const run = app.run(ac.signal, undefined, onStatus)
    this.runPromise = run
    // run() resolves on a clean stop (an abort, handled by stopBridge / the next
    // build) and rejects only on a fatal stream error — the shared event stream is
    // dead, so every channel degrades. Observe it so that failure becomes status
    // rather than an unhandled rejection.
    run
      .then(() => {})
      .catch((err) => {
        if (this.ac !== ac) return
        for (const account of this.accounts) {
          this.putChannel({ platform: account.platform, state: "degraded", identity: this.pairerFor(account).identity(account), error: message(err) })
        }
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

  private pairerFor(account: RemoteAccount): PlatformPairer {
    const pairer = this.pairers.get(account.platform)
    if (!pairer) throw new Error(`no pairer registered for ${account.platform}`)
    return pairer
  }

  private putChannel(status: RemoteChannelStatus): void {
    this.statusMap.set(status.platform, status)
    this.emitStatus()
  }

  private emitStatus(): void {
    const snapshot = this.getStatus()
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot)
      } catch {
        // a listener failure must not break status propagation
      }
    }
  }

  private emitPairing(event: RemotePairingEvent): void {
    for (const listener of this.pairingListeners) {
      try {
        listener(event)
      } catch {
        // a listener failure must not break pairing propagation
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
