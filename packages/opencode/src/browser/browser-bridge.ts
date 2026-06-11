/**
 * Inversion-of-control port between the embedded server and the desktop main
 * process for embedded-browser automation.
 *
 * The desktop main process owns the WebContentsView and its sealed CDP bridge
 * (`ws://127.0.0.1:<port>/<secret>`); the server side (BrowserSession, browser
 * tools) only ever sees this Host interface. Because the server runs in the
 * main process (`virtual:opencode-server` is imported in-process), the host is
 * injected as a same-process value — the endpoint and its secret never cross
 * renderer IPC or preload (PR1 security contract rule 7).
 */

export type BrowserBridgeErrorCode =
  // No host injected: not running inside the PawWork desktop app.
  | "bridge-unavailable"
  // Forwarded from the main-process CdpBridgeError (cdp-bridge.ts).
  | "target-busy"
  | "target-destroyed"
  | "bridge-start-timeout"

const HOST_ERROR_CODES: ReadonlySet<string> = new Set([
  "target-busy",
  "target-destroyed",
  "bridge-start-timeout",
] satisfies BrowserBridgeErrorCode[])

export class BrowserBridgeError extends Error {
  constructor(
    readonly code: BrowserBridgeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "BrowserBridgeError"
  }
}

/**
 * Normalize anything thrown across the host boundary into a typed
 * BrowserBridgeError. The main process cannot import this class (it only loads
 * the built server bundle), so recognition is structural via `code`.
 */
export function toBrowserBridgeError(err: unknown): BrowserBridgeError {
  if (err instanceof BrowserBridgeError) return err
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (typeof code === "string" && HOST_ERROR_CODES.has(code)) {
    return new BrowserBridgeError(code as BrowserBridgeErrorCode, message)
  }
  return new BrowserBridgeError("bridge-unavailable", message)
}

export namespace BrowserBridge {
  export type Endpoint = { cdpEndpoint: string }

  /** What the session's own page shows at permission time; null url = blank or non-web page. */
  export type PageProbe = { url: string | null }

  export interface Host {
    /**
     * Resolve (and lazily start) the CDP bridge over `sessionID`'s own
     * embedded-browser view — the session's root id, since views belong to
     * the conversation the user sees. Identity by construction: the action
     * can only ever land in that conversation's view. Throws a
     * `code`-carrying error on failure (see BrowserBridgeErrorCode).
     */
    resolveEndpoint(input: { sessionID: string }): Promise<Endpoint>
    /**
     * Read the URL of `sessionID`'s embedded-browser view — null when the
     * view doesn't exist yet or shows no http(s) page. MUST be side-effect
     * free — it runs BEFORE the permission ask, so it may not attach a
     * bridge, create a view, or send any CDP command.
     */
    probeSession(input: { sessionID: string }): Promise<PageProbe>
    /**
     * Detach the CDP bridge that was attached on behalf of `sessionID`.
     * Called when the server-side CONNECTION goes away (lost, timed out,
     * aborted); the view itself lives on for the conversation. A no-op for
     * sessions that never attached.
     */
    releaseSession(input: { sessionID: string }): Promise<void>
    /**
     * The conversation is gone (session deleted or archived): destroy its
     * embedded-browser view outright — page, history, automation. Without
     * this, every conversation that ever opened the embedded browser leaks a
     * live WebContentsView in the desktop main process for the app lifetime.
     * A no-op for sessions that never had a view.
     */
    disposeSession(input: { sessionID: string }): Promise<void>
  }

  let current: Host | null = null

  /** Called once by the desktop main process right after the server starts. */
  export function provideHost(host: Host | null) {
    current = host
  }

  export function available(): boolean {
    return current !== null
  }

  export function host(): Host {
    if (!current)
      throw new BrowserBridgeError(
        "bridge-unavailable",
        "Browser automation is only available inside the PawWork desktop app.",
      )
    return current
  }
}
