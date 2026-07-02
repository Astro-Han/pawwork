import { BrowserWindow } from "electron"
import { browserControllers } from "./controller-automation"
import type { AutomationEndpoint } from "./cdp-bridge"

export const BROWSER_AUTOMATION_ATTACHED_CHANNEL = "browser:automation-attached"

/** The desktop's side of the opencode BrowserBridge host contract. */
export type BrowserBridgeHost = {
  resolveEndpoint(input: { sessionID: string }): Promise<AutomationEndpoint>
  probeSession(input: { sessionID: string }): Promise<{ url: string | null }>
  releaseSession(input: { sessionID: string }): Promise<void>
  disposeSession(input: { sessionID: string }): Promise<void>
}

/**
 * BrowserBridge host: with views owned by conversations, session → endpoint
 * resolution is the identity mapping — ensure the conversation's view and
 * attach the CDP bridge to it. No window selection, no lease: a session's
 * action can only ever land in that session's own view, so the TOCTOU class
 * the lease machinery guarded (permission judged in one window, action landing
 * in another) is unrepresentable. The endpoint/secret stays a same-process
 * value, never crossing renderer IPC or preload.
 */
export function createDesktopBrowserBridgeHost(): BrowserBridgeHost {
  return {
    async resolveEndpoint({ sessionID }) {
      const endpoint = await browserControllers.ensure(sessionID).attachAutomation()
      // Surface the takeover: tell every window which conversation is being
      // driven, so renderers open that conversation's browser tab — and only
      // that conversation's.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(BROWSER_AUTOMATION_ATTACHED_CHANNEL, { sessionID })
      }
      return endpoint
    },

    // Side-effect-free by contract (browser-bridge.ts Host.probeSession): the
    // server calls this BEFORE the permission ask, so it must never create or
    // attach anything. No view yet means no embedded page — null URL.
    async probeSession({ sessionID }) {
      return { url: browserControllers.get(sessionID)?.state().url || null }
    },

    async releaseSession({ sessionID }) {
      await browserControllers.get(sessionID)?.detachAutomation()
    },

    // The conversation was deleted or archived: its view dies with it (page,
    // history, automation, the WebContentsView itself). Without this, every
    // conversation that ever opened the embedded browser would keep a live
    // Chromium page in the main process for the app lifetime.
    async disposeSession({ sessionID }) {
      browserControllers.dispose(sessionID)
    },
  }
}
