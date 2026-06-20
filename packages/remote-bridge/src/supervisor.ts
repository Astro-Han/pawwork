// Multi-platform supervision. Each platform runs in its own restart loop so one
// channel's failure stays isolated: a dead channel goes "degraded" and retries
// with backoff while the others keep serving. This replaces the old
// all-or-nothing start, where a single platform's start() rejection rejected a
// shared deferred and tore the whole bridge down.
//
// A dead *channel* must not take the bridge down; a dead PawWork *event stream*
// still does — that failure path lives in the gateway, not here.
//
// Each platform gets its own child AbortController linked to the run signal, so a
// single channel can be added to or removed from a running supervisor without
// touching the others (Wave 2: connect/disconnect one channel restarts only it,
// never the shared stream or its siblings). A removed/replaced entry carries a
// generation token, so its in-flight loop can no longer write status after a
// newer entry takes its name.

import type { MessageHandler, Platform } from "./types.ts"

export type PlatformPhase = "starting" | "serving" | "degraded"

/** A per-platform lifecycle update, so the UI can show each channel's state. */
export interface PlatformStatus {
  name: string
  phase: PlatformPhase
  /** Present only for "degraded": the failure that knocked the platform down. */
  error?: string
}

export interface SuperviseOptions {
  /** Per-platform lifecycle updates (starting / serving / degraded). */
  onStatus?: (status: PlatformStatus) => void
  /** Fires once per platform, the first time it reaches "serving" (deduped). */
  onPlatformReady?: (platform: Platform) => void
  /** Base delay before restarting a failed platform; doubles each retry, capped. */
  backoffMs?: number
  /** Ceiling on the restart backoff, so a permanently-dead channel idles, not spins. */
  maxBackoffMs?: number
}

const DEFAULT_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 60_000

interface SupervisedEntry {
  platform: Platform
  /** Aborts just this platform's loop (linked to the run signal). */
  ac: AbortController
  /** Resolves when this platform's supervise loop has fully wound down. */
  done: Promise<void>
  /** Monotonic token; a stale loop's late callbacks are dropped once superseded. */
  token: number
}

/**
 * A live registry of supervised platforms. Each `add` starts one platform's
 * restart loop under a child AbortController linked to the run signal; `remove`
 * aborts, stops, and awaits just that platform; aborting the run signal (or
 * `stopAll`) winds them all down. This is the seam that lets the desktop runtime
 * connect or disconnect a single channel without rebuilding the shared bridge.
 */
export class PlatformSupervisor {
  private readonly entries = new Map<string, SupervisedEntry>()
  private nextToken = 0

  constructor(
    private readonly handler: MessageHandler,
    /** The run signal: aborting it tears down every supervised platform. */
    private readonly signal: AbortSignal,
    private readonly options: SuperviseOptions = {},
  ) {}

  /** Whether a platform with this name is currently supervised. */
  has(name: string): boolean {
    return this.entries.has(name)
  }

  /**
   * Start supervising one platform. Idempotent per name: a second add for a name
   * already present is ignored (callers replace via `remove` then `add`). A no-op
   * once the run signal has aborted.
   */
  add(platform: Platform): void {
    if (this.signal.aborted || this.entries.has(platform.name)) return
    const ac = new AbortController()
    const onParentAbort = () => ac.abort()
    this.signal.addEventListener("abort", onParentAbort, { once: true })
    const token = ++this.nextToken
    // Guard every callback by the live entry's token, so a removed or replaced
    // platform's late status / ready can't clobber a newer entry under its name.
    const current = () => this.entries.get(platform.name)?.token === token
    const guarded: SuperviseOptions = {
      ...this.options,
      onStatus: (status) => {
        if (current()) this.options.onStatus?.(status)
      },
      onPlatformReady: (ready) => {
        if (current()) this.options.onPlatformReady?.(ready)
      },
    }
    // Register the entry BEFORE starting the loop, so the first status superviseOne
    // emits synchronously (`starting`) passes the token guard. `done` is filled on
    // the same tick — no await before it — so remove/stopAll always await the loop.
    const entry: SupervisedEntry = { platform, ac, done: Promise.resolve(), token }
    this.entries.set(platform.name, entry)
    entry.done = superviseOne(platform, this.handler, ac.signal, guarded).finally(() =>
      this.signal.removeEventListener("abort", onParentAbort),
    )
  }

  /**
   * Stop supervising one platform: abort its loop, stop the platform to unblock a
   * hanging start(), then await the loop's wind-down. The entry is removed first,
   * so any final callback the loop emits is dropped by the token guard. No-op if
   * the name is not supervised.
   */
  async remove(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    entry.ac.abort()
    await entry.platform.stop().catch(() => {})
    await entry.done
  }

  /** Tear down every supervised platform — run shutdown / fatal-stream restart. */
  async stopAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) entry.ac.abort()
    await Promise.all(entries.map((entry) => entry.platform.stop().catch(() => {})))
    await Promise.all(entries.map((entry) => entry.done))
  }

  /** Resolves when every currently-supervised loop has wound down (e.g. on abort),
   *  without stopping the platforms — the run-loop's clean "await the loops" path. */
  whenIdle(): Promise<void> {
    return Promise.all([...this.entries.values()].map((entry) => entry.done)).then(() => {})
  }
}

/**
 * Run a fixed set of platforms under one supervisor for the lifetime of `signal`.
 * Thin wrapper over {@link PlatformSupervisor} for callers that never add or
 * remove a platform mid-run. Resolves only when `signal` aborts; never rejects
 * for a single platform's failure.
 */
export function supervisePlatforms(
  platforms: Platform[],
  handler: MessageHandler,
  signal: AbortSignal,
  options: SuperviseOptions = {},
): Promise<void> {
  const supervisor = new PlatformSupervisor(handler, signal, options)
  for (const platform of platforms) supervisor.add(platform)
  return supervisor.whenIdle()
}

async function superviseOne(
  platform: Platform,
  handler: MessageHandler,
  signal: AbortSignal,
  options: SuperviseOptions,
): Promise<void> {
  const base = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const max = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  let backoff = base
  let counted = false
  const status = (phase: PlatformPhase, error?: string) => options.onStatus?.({ name: platform.name, phase, error })
  const ready = () => {
    // A healthy serve clears the backoff and any prior "degraded".
    backoff = base
    status("serving")
    if (counted) return
    counted = true
    options.onPlatformReady?.(platform)
  }

  while (!signal.aborted) {
    status("starting")
    // Promise.resolve().then absorbs a synchronous throw from a misbehaving
    // adapter's start(), so it degrades and retries like an async failure rather
    // than tearing the supervisor down.
    const startPromise = Promise.resolve().then(() => platform.start(handler, ready))
    const outcome = await raceStartOrAbort(startPromise, signal)
    // A requested stop is not a degradation, and a clean self-stop is not a
    // failure: in both cases end the loop without restarting.
    if (signal.aborted || !outcome.failed) return
    status("degraded", outcome.error)
    await sleep(backoff, signal)
    backoff = Math.min(backoff * 2, max)
  }
}

type StartOutcome = { failed: false } | { failed: true; error: string }

// Race start() against an abort, removing the abort listener as soon as start
// settles — otherwise a platform that keeps failing and retrying leaks one abort
// listener per attempt. Abort is reported as a non-failure; the caller ends the
// loop on signal.aborted. start()'s rejection is consumed here, so abort winning
// the race never leaves a late rejection unhandled.
function raceStartOrAbort(start: Promise<void>, signal: AbortSignal): Promise<StartOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ failed: false })
    const onAbort = () => resolve({ failed: false })
    signal.addEventListener("abort", onAbort, { once: true })
    const settle = (outcome: StartOutcome) => {
      signal.removeEventListener("abort", onAbort)
      resolve(outcome)
    }
    start.then(
      () => settle({ failed: false }),
      (err) => settle({ failed: true, error: message(err) }),
    )
  })
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
