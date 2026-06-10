import type { AutomationEndpoint } from "./cdp-bridge"

/**
 * Picks which window's embedded browser an agent session drives, and exposes
 * that choice to the in-process server as a BrowserBridge host (see
 * packages/opencode/src/browser/browser-bridge.ts). Selection contract:
 *
 *  1. a window currently showing the session (renderer-reported
 *     DesktopContext.sessionID) wins;
 *  2. otherwise a single open window serves everything (incl. background
 *     automations whose session is visible nowhere);
 *  3. otherwise the focused window — the user is looking at it, which matches
 *     the product rule that agent browsing stays visible;
 *  4. several unfocused windows and no session match is ambiguous: typed
 *     error, never drive a window the user may not be watching.
 *
 * Electron-free by construction (deps injected, electron imported as types
 * only) so the whole module runs under bun test; the electron wiring lives in
 * automation-host.ts.
 */

export type AutomationWindowCandidate = { windowID: number; sessionID: string | null }

export type AutomationWindowPick = { windowID: number } | { error: "no-window" | "window-ambiguous" }

export function pickAutomationWindow(input: {
  sessionID: string
  candidates: AutomationWindowCandidate[]
  focusedWindowID: number | null
}): AutomationWindowPick {
  const { candidates, focusedWindowID } = input
  if (candidates.length === 0) return { error: "no-window" }
  const showing = candidates.filter((c) => c.sessionID === input.sessionID)
  if (showing.length > 0) {
    const focused = showing.find((c) => c.windowID === focusedWindowID)
    return { windowID: (focused ?? showing[0]).windowID }
  }
  if (candidates.length === 1) return { windowID: candidates[0].windowID }
  const focused = candidates.find((c) => c.windowID === focusedWindowID)
  if (focused) return { windowID: focused.windowID }
  return { error: "window-ambiguous" }
}

function hostError(code: "no-window" | "window-ambiguous"): Error & { code: string } {
  const message =
    code === "no-window"
      ? "No PawWork window is open to host the embedded browser."
      : "Several windows are open and none is focused or showing this session; focus the window the agent should use."
  return Object.assign(new Error(message), { code })
}

export type BrowserBridgeHost = {
  resolveEndpoint(input: { sessionID: string; windowID?: number }): Promise<AutomationEndpoint>
  probeWindow(input: { sessionID: string }): Promise<{ windowID: number; url: string | null } | null>
  releaseSession(input: { sessionID: string }): Promise<void>
}

export type BrowserBridgeHostDeps = {
  windows(): AutomationWindowCandidate[]
  focusedWindowID(): number | null
  attachWindow(windowID: number): Promise<AutomationEndpoint>
  detachWindow(windowID: number): Promise<void>
  /** Embedded-browser URL of a window's existing view; null when none. Must not create a view. */
  windowUrl(windowID: number): string | null
}

/**
 * Bridge host backed by the live window list and the renderer-reported
 * per-window DesktopContext. Tracks which window each session attached so
 * releaseSession can detach exactly that bridge later.
 */
export function createBrowserBridgeHost(deps: BrowserBridgeHostDeps): BrowserBridgeHost {
  const attached = new Map<string, number>()

  return {
    async resolveEndpoint({ sessionID, windowID }) {
      // A windowID is the probe's lease: attach exactly that window, so the
      // action runs where the permission's URL was read even if focus moved
      // during the ask. A closed window fails as no-window instead of being
      // silently re-picked — the permission grant doesn't transfer.
      let target = windowID
      if (target !== undefined && !deps.windows().some((c) => c.windowID === target)) {
        throw hostError("no-window")
      }
      if (target === undefined) {
        const pick = pickAutomationWindow({
          sessionID,
          candidates: deps.windows(),
          focusedWindowID: deps.focusedWindowID(),
        })
        if ("error" in pick) throw hostError(pick.error)
        target = pick.windowID
      }
      const endpoint = await deps.attachWindow(target)
      attached.set(sessionID, target)
      return endpoint
    },

    // Side-effect-free by contract (browser-bridge.ts Host.probeWindow): the
    // server calls this BEFORE the permission ask, so it only picks a window
    // and reads its existing view's URL — never attaches or creates anything.
    // A window the session is already attached to wins over a fresh pick, so
    // the permission is judged against the page the action will actually run
    // on, not wherever focus happens to be.
    async probeWindow({ sessionID }) {
      const candidates = deps.windows()
      const attachedWindow = attached.get(sessionID)
      if (attachedWindow !== undefined && candidates.some((c) => c.windowID === attachedWindow)) {
        return { windowID: attachedWindow, url: deps.windowUrl(attachedWindow) }
      }
      const pick = pickAutomationWindow({
        sessionID,
        candidates,
        focusedWindowID: deps.focusedWindowID(),
      })
      if ("error" in pick) return null
      return { windowID: pick.windowID, url: deps.windowUrl(pick.windowID) }
    },

    async releaseSession({ sessionID }) {
      const windowID = attached.get(sessionID)
      if (windowID === undefined) return
      attached.delete(sessionID)
      // Other sessions that attached to the same window are stale by now (the
      // ws bridge is single-connection); drop their mappings too so they don't
      // detach a future bridge they no longer own.
      for (const [otherSession, otherWindow] of attached) {
        if (otherWindow === windowID) attached.delete(otherSession)
      }
      await deps.detachWindow(windowID)
    },
  }
}
