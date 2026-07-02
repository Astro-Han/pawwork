import { CDPBridge } from "@jackwener/opencli/browser/cdp"
import type { IPage } from "@jackwener/opencli/types"
import { BrowserBridge, BrowserBridgeError, toBrowserBridgeError } from "./browser-bridge"

/**
 * Server-side owner of the live CDP connection into the embedded browser.
 *
 * One connection per CONVERSATION: views (and their sealed ws bridges) belong
 * to root sessions, so session → endpoint is the identity mapping. Sessions
 * are tracked by their ROOT id — subagent calls resolve to the conversation
 * the user actually sees — and the connection is torn down when that session
 * is deleted or archived (see releaseBrowserSession, wired into
 * Session.clearPendingInteractions).
 *
 * opencli's CDPBridge.connect() registers its stealth script via
 * Page.addScriptToEvaluateOnNewDocument, which only affects FUTURE documents.
 * Connecting before the view's first navigation covers the agent-first flow;
 * when the agent takes over a page the user already opened, connect() reloads
 * it once so the current document gets the script too (reload is the only
 * contract-clean path — the stealth source itself is not a public export).
 */

/** Shorter than opencli's internal 30s CDP guard so tools fail first, with a browser-flavored message. */
export const BROWSER_TOOL_TIMEOUT_MS = 25_000

/** Best-effort wait for the takeover reload to settle; navigation state events keep flowing afterwards either way. */
const TAKEOVER_RELOAD_TIMEOUT_MS = 10_000

export class BrowserToolTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Browser ${label} timed out after ${Math.round(ms / 1000)}s. The page may still be loading; try browser_wait or a simpler action.`)
    this.name = "BrowserToolTimeoutError"
  }
}

export class BrowserActionCanceledError extends Error {
  constructor(label: string) {
    super(`Browser ${label} was canceled.`)
    this.name = "BrowserActionCanceledError"
  }
}

/** Mirrors the desktop controller's parseNavigable: real URLs, web schemes only. */
export function parseNavigableUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
  return null
}

type Connection = {
  /** Owning root session — 1:1 with its conversation's view and endpoint. */
  session: string
  bridge: CDPBridge
  page: IPage
  closed: boolean
  /** True when connect() found an already-loaded page and reloaded it to apply stealth. */
  takeoverReloaded: boolean
}

const bySession = new Map<string, Connection>()
// In-flight first acquires: the underlying ws bridge accepts a single client,
// so two concurrent first calls for one conversation must share one attempt
// instead of racing into a second connection (which the bridge would reject).
const pendingAcquires = new Map<string, Promise<Connection>>()
// Release generation per conversation. A delete/archive cannot reliably see an
// in-flight acquire (it registers in pendingAcquires only after resolving its
// root id), so instead of the release waiting on the acquire, the acquire
// notices the bump after connecting and unwinds itself — otherwise its
// resolveEndpoint would resurrect the just-disposed view and the connection
// would outlive the conversation with nothing left to ever clean it up.
const releaseEpochs = new Map<string, number>()

// Every way the underlying connection reports being gone: opencli's send()
// pre-check ("CDP connection is not open"), its close() ("CDP connection
// closed"), and the main-process bridge failing in-flight commands on
// teardown ("bridge closed").
const CONNECTION_LOST = /CDP connection is not open|CDP connection closed|bridge closed/i

function isConnectionLoss(err: unknown): boolean {
  return err instanceof Error && CONNECTION_LOST.test(err.message)
}

/** Windows show root sessions; map a (possibly subagent) session to the conversation the user sees. */
async function rootSessionID(sessionID: string): Promise<string> {
  // Lazy import: session/session.ts calls releaseBrowserSession on delete and
  // archive, so a static import here would close an import cycle.
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Session } = await import("@/session")
  let id = sessionID as import("@/session/schema").SessionID
  // Bounded walk: parent chains are shallow, and a cycle in corrupt data must not hang a tool.
  for (let i = 0; i < 16; i++) {
    const info = await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(id))).catch(() => undefined)
    if (!info?.parentID) return id
    id = info.parentID
  }
  return id
}

async function currentPageUrl(page: IPage): Promise<string | null> {
  if (page.getCurrentUrl) return page.getCurrentUrl()
  try {
    const url = await page.evaluate<string>("window.location.href")
    return typeof url === "string" ? url : null
  } catch {
    return null
  }
}

async function connect(session: string, endpoint: string): Promise<Connection> {
  const bridge = new CDPBridge()
  const page = await bridge.connect({ cdpEndpoint: endpoint })
  const conn: Connection = {
    session,
    bridge,
    page,
    closed: false,
    takeoverReloaded: false,
  }
  // Stealth takeover: addScriptToEvaluateOnNewDocument (registered inside
  // connect()) misses the document that is already committed. Reload it once
  // so user-opened pages behave the same as agent-opened ones.
  const url = await currentPageUrl(page)
  if (url && parseNavigableUrl(url)) {
    conn.takeoverReloaded = true
    const loaded = bridge.waitForEvent("Page.loadEventFired", TAKEOVER_RELOAD_TIMEOUT_MS).catch(() => undefined)
    await bridge.send("Page.reload", {})
    await loaded
  }
  return conn
}

function invalidate(conn: Connection) {
  if (conn.closed) return
  conn.closed = true
  bySession.delete(conn.session)
  void conn.bridge.close().catch(() => {})
  // Tell the main process to drop its attachment now: with the bySession
  // mapping gone, a later session delete/archive can no longer do it, and the
  // host would keep a stale bridge alive forever. Best-effort — a re-acquire
  // re-attaches regardless.
  if (BrowserBridge.available()) {
    void BrowserBridge.host()
      .releaseSession({ sessionID: conn.session })
      .catch(() => {})
  }
}

async function acquire(sessionID: string): Promise<Connection> {
  const root = await rootSessionID(sessionID)
  const cached = bySession.get(root)
  if (cached && !cached.closed) return cached

  // Single-flight per root: a failed attempt clears itself so the next call
  // retries fresh; concurrent callers share the same outcome either way.
  const inflight = pendingAcquires.get(root)
  if (inflight) return inflight
  const promise = (async () => {
    const epoch = releaseEpochs.get(root)
    const endpoint = await BrowserBridge.host()
      .resolveEndpoint({ sessionID: root })
      .catch((err) => {
        throw toBrowserBridgeError(err)
      })
    let conn: Connection
    try {
      conn = await connect(root, endpoint.cdpEndpoint)
    } catch (err) {
      // resolveEndpoint already attached the host's bridge, but nothing on
      // this side maps the session yet — a later release would no-op and
      // leak the attachment. Undo it now.
      await BrowserBridge.host()
        .releaseSession({ sessionID: root })
        .catch(() => {})
      throw err
    }
    if (releaseEpochs.get(root) !== epoch) {
      // The conversation was deleted or archived while we were connecting —
      // resolveEndpoint resurrected its view after the release disposed it.
      // Unwind completely: close the socket, dispose the recreated view.
      conn.closed = true
      await conn.bridge.close().catch(() => {})
      await BrowserBridge.host()
        .disposeSession({ sessionID: root })
        .catch(() => {})
      throw new Error("The conversation was deleted while the browser was connecting.")
    }
    bySession.set(root, conn)
    return conn
  })().finally(() => pendingAcquires.delete(root))
  pendingAcquires.set(root, promise)
  return promise
}

export type BrowserPageRun<T> = (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>

/**
 * Run one tool action against the session's embedded-browser page: lazy
 * connect + cache, a tool-level timeout that beats opencli's internal 30s
 * guard, and cache invalidation on connection loss so the next call
 * re-resolves and reconnects instead of failing forever.
 */
export async function withBrowserPage<T>(
  sessionID: string,
  label: string,
  run: BrowserPageRun<T>,
  opts?: { timeoutMs?: number; abort?: AbortSignal },
): Promise<T> {
  if (opts?.abort?.aborted) throw new BrowserActionCanceledError(label)
  const ms = opts?.timeoutMs ?? BROWSER_TOOL_TIMEOUT_MS
  let conn: Connection | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  // Abort and timeout don't just stop the wait — they sever the connection.
  // CDP has no command-level cancel, so an orphaned run() would otherwise
  // keep driving the page after the user hit stop (or after the tool already
  // reported failure). Closing the socket fails its in-flight and subsequent
  // commands locally; the next action re-probes and reconnects (which may
  // stealth-reload an already-loaded page, like any fresh takeover).
  //
  // The race covers acquire() too — the first action's endpoint resolution and
  // CDP connect answer to the same budget and the same stop button. The abort
  // listener registers BEFORE acquire on purpose: a signal that fires mid-
  // acquire would never fire a listener added after it ("abort" does not
  // re-fire on already-aborted signals), and the canceled action would run
  // anyway. Severing is conditional because there is no connection until
  // acquire returns; an abandoned in-flight acquire settles in the background
  // and only fills the cache for the next action.
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (conn) invalidate(conn)
      reject(new BrowserToolTimeoutError(label, ms))
    }, ms)
    onAbort = () => {
      if (conn) invalidate(conn)
      reject(new BrowserActionCanceledError(label))
    }
    opts?.abort?.addEventListener("abort", onAbort, { once: true })
  })
  try {
    const acquiring = acquire(sessionID)
    // The race abandons this promise when interrupted wins; its eventual
    // rejection must not surface as an unhandled error.
    acquiring.catch(() => {})
    conn = await Promise.race([acquiring, interrupted])
    const takeoverReloaded = conn.takeoverReloaded
    // One-shot flag: only the first action after a takeover mentions the reload.
    conn.takeoverReloaded = false
    return await Promise.race([run(conn.page, { takeoverReloaded }), interrupted])
  } catch (err) {
    if (conn && isConnectionLoss(err)) {
      invalidate(conn)
      // The connection dying mid-action means the page was closed out from
      // under the tool — the user closed the browser tab, or the conversation
      // was torn down. The raw "CDP connection is not open" says neither what
      // happened nor what to do; say both. No automatic retry: a close is the
      // user's call, and silently reopening would override it.
      throw new Error(
        `The browser page was closed while ${label} was running. The next browser action starts over from a fresh blank page.`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (onAbort) opts?.abort?.removeEventListener("abort", onAbort)
  }
}

/**
 * The session was deleted or archived: drop its browser connection and have
 * the desktop destroy its view outright. Uses the id as given — connections
 * and views only ever exist under ROOT ids, so a root delete matches exactly
 * and a subagent-child delete no-ops at every step instead of tearing down
 * the conversation's live connection.
 */
export async function releaseBrowserSession(sessionID: string): Promise<void> {
  // Bump first: an acquire still in flight for this conversation unwinds
  // itself when it sees the new epoch (see acquire) — it cannot be awaited
  // here because it may not have registered in pendingAcquires yet, and a
  // hung endpoint resolution must not block the session's deletion. Maps and
  // the host registry are only ever populated under ROOT ids, so a child-
  // session delete (remove() recurses) lands here as a harmless no-op.
  releaseEpochs.set(sessionID, (releaseEpochs.get(sessionID) ?? 0) + 1)
  const conn = bySession.get(sessionID)
  if (conn) {
    bySession.delete(sessionID)
    conn.closed = true
    await conn.bridge.close().catch(() => {})
  }
  // Dispose unconditionally, not just when a connection exists: a conversation
  // the user browsed by hand has a live view but never had a CDP connection,
  // and its view must still die with the session. disposeSession implies the
  // bridge detach that releaseSession would have done.
  if (BrowserBridge.available()) {
    await BrowserBridge.host()
      .disposeSession({ sessionID })
      .catch(() => {})
  }
}

/**
 * The page URL the permission should be judged against — the session's OWN
 * view's URL, read from main-process view state, deliberately NOT through the
 * CDP connection: this runs BEFORE the permission ask, and connecting would
 * already stealth-reload a page the user has open. A null url means a blank
 * or non-web page, which the caller maps to the `*` pattern so the baseline
 * rule still applies. The action can only ever land in that same view; the
 * caller re-probes after the ask and re-judges a page that moved meanwhile
 * (see runBrowserAction).
 */
export async function browserPageProbe(sessionID: string): Promise<{ url: string | null }> {
  const root = await rootSessionID(sessionID)
  const probe = await BrowserBridge.host()
    .probeSession({ sessionID: root })
    .catch((err) => {
      throw toBrowserBridgeError(err)
    })
  return { url: probe.url && parseNavigableUrl(probe.url) ? probe.url : null }
}

/** True when running inside the desktop app with a bridge host injected. */
export function browserAutomationAvailable(): boolean {
  return BrowserBridge.available()
}

export { BrowserBridgeError }

/** Test seam: reset module state between tests. */
export function resetBrowserSessionsForTest() {
  for (const conn of bySession.values()) {
    conn.closed = true
    void conn.bridge.close().catch(() => {})
  }
  bySession.clear()
  pendingAcquires.clear()
  releaseEpochs.clear()
}
