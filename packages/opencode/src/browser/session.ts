import { CDPBridge } from "@jackwener/opencli/browser/cdp"
import type { IPage } from "@jackwener/opencli/types"
import { BrowserBridge, BrowserBridgeError, toBrowserBridgeError } from "./browser-bridge"

/**
 * Server-side owner of the live CDP connection into the embedded browser.
 *
 * One connection per window endpoint, shared by every agent session that the
 * main-process resolver routes to that window (the sealed ws bridge accepts a
 * single client, so a second connection could never coexist anyway). Sessions
 * are tracked by their ROOT id — subagent calls resolve to the conversation
 * the user actually sees — and the connection is torn down when the last
 * session referencing it is deleted or archived (see releaseBrowserSession,
 * wired into Session.clearPendingInteractions).
 *
 * opencli's CDPBridge.connect() registers its stealth script via
 * Page.addScriptToEvaluateOnNewDocument, which only affects FUTURE documents.
 * Connecting before the view's first navigation (guaranteed by PR1: the
 * debugger attaches at view construction) covers the agent-first flow; when
 * the agent takes over a page the user already opened, connect() reloads it
 * once so the current document gets the script too (reload is the only
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
  endpoint: string
  bridge: CDPBridge
  page: IPage
  sessions: Set<string>
  closed: boolean
  /** True when connect() found an already-loaded page and reloaded it to apply stealth. */
  takeoverReloaded: boolean
}

const byEndpoint = new Map<string, Connection>()
const bySession = new Map<string, Connection>()

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
  const { Session } = await import("@/session")
  let id = sessionID as import("@/session/schema").SessionID
  // Bounded walk: parent chains are shallow, and a cycle in corrupt data must not hang a tool.
  for (let i = 0; i < 16; i++) {
    const info = await Session.get(id).catch(() => undefined)
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

async function connect(endpoint: string): Promise<Connection> {
  const bridge = new CDPBridge()
  const page = await bridge.connect({ cdpEndpoint: endpoint })
  const conn: Connection = {
    endpoint,
    bridge,
    page,
    sessions: new Set(),
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
  byEndpoint.delete(conn.endpoint)
  for (const id of conn.sessions) bySession.delete(id)
  void conn.bridge.close().catch(() => {})
}

async function acquire(sessionID: string): Promise<Connection> {
  const root = await rootSessionID(sessionID)
  const cached = bySession.get(root)
  if (cached && !cached.closed) return cached

  const endpoint = await BrowserBridge.host()
    .resolveEndpoint({ sessionID: root })
    .catch((err) => {
      throw toBrowserBridgeError(err)
    })

  let conn = byEndpoint.get(endpoint.cdpEndpoint)
  if (!conn || conn.closed) {
    conn = await connect(endpoint.cdpEndpoint)
    byEndpoint.set(endpoint.cdpEndpoint, conn)
  }
  conn.sessions.add(root)
  bySession.set(root, conn)
  return conn
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
  opts?: { timeoutMs?: number },
): Promise<T> {
  const conn = await acquire(sessionID)
  const takeoverReloaded = conn.takeoverReloaded
  // One-shot flag: only the first action after a takeover mentions the reload.
  conn.takeoverReloaded = false
  const ms = opts?.timeoutMs ?? BROWSER_TOOL_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserToolTimeoutError(label, ms)), ms)
  })
  try {
    return await Promise.race([run(conn.page, { takeoverReloaded }), timeout])
  } catch (err) {
    if (isConnectionLoss(err)) invalidate(conn)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Drop the session's claim on its browser connection; closes the connection
 * and detaches the main-process bridge when the last claim goes. Wired into
 * session delete/archive. Keyed by root session id, so deleting a subagent
 * child never tears down the conversation's live connection.
 */
export async function releaseBrowserSession(sessionID: string): Promise<void> {
  const conn = bySession.get(sessionID)
  if (!conn) return
  bySession.delete(sessionID)
  conn.sessions.delete(sessionID)
  if (conn.sessions.size > 0) return
  conn.closed = true
  byEndpoint.delete(conn.endpoint)
  await conn.bridge.close().catch(() => {})
  if (BrowserBridge.available()) {
    await BrowserBridge.host()
      .releaseSession({ sessionID })
      .catch(() => {})
  }
}

/**
 * The page's current navigable URL, for scoping a browser permission to where
 * the page actually is. Read from the main process's view state (the same
 * window pick acquire() will use later) — deliberately NOT through the CDP
 * connection: this runs BEFORE the permission ask, and connecting would
 * already stealth-reload a page the user has open. Returns null when
 * unavailable — no bridge, no window, blank page — which the caller maps to
 * the `*` pattern so the baseline rule still applies.
 */
export async function browserPageUrl(sessionID: string): Promise<string | null> {
  if (!BrowserBridge.available()) return null
  const root = await rootSessionID(sessionID)
  const url = await BrowserBridge.host()
    .currentUrl({ sessionID: root })
    .catch(() => null)
  return url && parseNavigableUrl(url) ? url : null
}

/** True when running inside the desktop app with a bridge host injected. */
export function browserAutomationAvailable(): boolean {
  return BrowserBridge.available()
}

export { BrowserBridgeError }

/** Test seam: reset module state between tests. */
export function resetBrowserSessionsForTest() {
  for (const conn of byEndpoint.values()) {
    conn.closed = true
    void conn.bridge.close().catch(() => {})
  }
  byEndpoint.clear()
  bySession.clear()
}
