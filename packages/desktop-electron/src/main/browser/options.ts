import type { WebPreferences } from "electron"

/**
 * Single app-owned persistent partition: one browsing session shared by every
 * window, surviving restarts. `persist:` keeps cookies/storage on disk so logins
 * stick; clear-data wipes it. Multi-profile is intentionally out of scope (#1186).
 */
export const BROWSER_PARTITION = "persist:pawwork-browser"

/**
 * WebPreferences for the embedded browser's WebContentsView. It loads arbitrary
 * external sites, so it is locked down and deliberately distinct from the app
 * renderer (window-options.ts): no preload — the page must never receive the
 * app's IPC bridge — plus sandbox, context isolation, no Node, web security on.
 */
export function browserViewWebPreferences(): WebPreferences {
  return {
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
  }
}
