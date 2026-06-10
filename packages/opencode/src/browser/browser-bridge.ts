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
  // The host has no window that can serve the session.
  | "no-window"
  // Several windows are eligible and none can be picked safely.
  | "window-ambiguous"
  // Forwarded from the main-process CdpBridgeError (cdp-bridge.ts).
  | "target-busy"
  | "target-destroyed"
  | "bridge-start-timeout"

const HOST_ERROR_CODES: ReadonlySet<string> = new Set([
  "no-window",
  "window-ambiguous",
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

  /** A window pick frozen at permission time: where the action will run, and what that page shows now. */
  export type WindowProbe = { windowID: number; url: string | null }

  export interface Host {
    /**
     * Resolve (and lazily start) the CDP bridge for the window that should
     * serve `sessionID` — the session's root id, since windows display root
     * sessions. When `windowID` is given (the probe's lease), attach exactly
     * that window instead of re-picking, so a focus change between the
     * permission ask and the action cannot retarget it. Throws a
     * `code`-carrying error on failure (see BrowserBridgeErrorCode).
     */
    resolveEndpoint(input: { sessionID: string; windowID?: number }): Promise<Endpoint>
    /**
     * Pick the window that would serve `sessionID` (preferring the one it is
     * already attached to) and read its embedded browser's URL — a null url
     * means the window exists but shows no http(s) page. When NO window can
     * serve the session, this throws the same typed error resolveEndpoint
     * would (no-window / window-ambiguous); it never degrades to a result,
     * because an action without a lease could attach wherever focus lands.
     * MUST be side-effect free — it runs BEFORE the permission ask, so it may
     * not attach a bridge, create a view, or send any CDP command.
     */
    probeWindow(input: { sessionID: string }): Promise<WindowProbe>
    /**
     * Detach the window bridge that was attached on behalf of `sessionID`.
     * Called when the last server-side user of the connection goes away
     * (session deleted/archived); a no-op for sessions that never attached.
     */
    releaseSession(input: { sessionID: string }): Promise<void>
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
