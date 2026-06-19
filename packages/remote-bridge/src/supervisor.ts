// Multi-platform supervision. Each platform runs in its own restart loop so one
// channel's failure stays isolated: a dead channel goes "degraded" and retries
// with backoff while the others keep serving. This replaces the old
// all-or-nothing start, where a single platform's start() rejection rejected a
// shared deferred and tore the whole bridge down.
//
// A dead *channel* must not take the bridge down; a dead PawWork *event stream*
// still does — that failure path lives in the gateway, not here.
//
// No per-platform AbortController: `Platform` has no start-time signal (teardown
// is `stop()`), and Wave 1 disconnects a single channel by restarting the whole
// bridge, so an independent abort would have no consumer. Isolation comes from
// the independent loops below, not from a per-platform signal.

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

/**
 * Run every platform under independent supervision. Each gets its own restart
 * loop, so one platform's failure is isolated: it reports "degraded" and restarts
 * with exponential backoff while the others keep serving. A clean self-stop (an
 * event-driven adapter that registers its callback and returns) ends that
 * platform's loop without a restart. Resolves only when `signal` aborts; never
 * rejects for a single platform's failure.
 */
export function supervisePlatforms(
  platforms: Platform[],
  handler: MessageHandler,
  signal: AbortSignal,
  options: SuperviseOptions = {},
): Promise<void> {
  return Promise.all(platforms.map((platform) => superviseOne(platform, handler, signal, options))).then(() => {})
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
