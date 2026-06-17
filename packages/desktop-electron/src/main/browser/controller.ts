import { BrowserWindow, WebContentsView, shell } from "electron"
import type { BrowserState, BrowserViewLayout } from "@opencode-ai/app/desktop-api"
import { browserViewWebPreferences } from "./options"
import {
  clearDataReloadAction,
  computeViewBounds,
  deriveBrowserState,
  displayDecision,
  isDefaultGrantedPermission,
  parseNavigable,
  safeExternalUrl,
} from "./logic"
import { CdpBridge, type AutomationEndpoint } from "./cdp-bridge"
import { draftWindowID, rendererTarget } from "./registry"

export const BROWSER_STATE_CHANNEL = "browser:state"
export const BROWSER_DISPLAY_TAKEN_CHANNEL = "browser:display-taken"

/**
 * A view that has never been displayed still needs a real viewport: renderers
 * lay out against the view size, and CDP captureScreenshot on a 0×0 view has
 * nothing to render and times out. Unattached views keep this default until a
 * panel displays them.
 */
const DEFAULT_VIEW_BOUNDS = { x: 0, y: 0, width: 1280, height: 720 }

/**
 * Owns one embedded browser per CONVERSATION (root session) — or a per-window
 * draft on Home. The view lives unattached to any window; a window is just a
 * display: `display(win, rect)` reparents the view into the window currently
 * showing the conversation, `hideFor(win)` lets only that display owner hide
 * it. Page, history, and scroll live and die with the conversation, so
 * switching conversations can never show another conversation's page.
 */
export class BrowserViewController {
  private readonly view: WebContentsView
  private host: BrowserWindow | null = null
  private favicon: string | null = null
  private destroyed = false
  private automation: CdpBridge | null = null
  /** Saved throttling value while automation holds it off; null = not held. */
  private throttlingBefore: boolean | null = null

  constructor(private target: string) {
    this.view = new WebContentsView({ webPreferences: browserViewWebPreferences() })
    this.view.setVisible(false)
    this.view.setBounds(DEFAULT_VIEW_BOUNDS)
    this.wireEvents()
  }

  private get wc() {
    return this.view.webContents
  }

  /** Draft adoption rekeys the controller; state pushes follow the new owner. */
  retarget(target: string) {
    this.target = target
  }

  private wireEvents() {
    const wc = this.wc
    wc.on("did-start-loading", () => this.emitState())
    wc.on("did-stop-loading", () => this.emitState())
    wc.on("did-navigate", () => {
      this.favicon = null
      this.emitState()
    })
    wc.on("did-navigate-in-page", () => this.emitState())
    wc.on("page-title-updated", () => this.emitState())
    wc.on("page-favicon-updated", (_event, favicons: string[]) => {
      this.favicon = favicons[0] ?? null
      this.emitState()
    })
    wc.on("did-fail-load", () => this.emitState())

    // Single-view browser: keep http(s) "open in new window" links in-place and
    // hand any other scheme to the system browser. Never spawn a child window.
    wc.setWindowOpenHandler(({ url }) => {
      const navigable = parseNavigable(url)
      if (navigable) void this.loadInternal(navigable)
      else this.openExternal(url)
      return { action: "deny" }
    })

    // Block link navigations to non-web schemes (file://, etc.); route real
    // external schemes to the system browser instead of failing silently.
    wc.on("will-navigate", (event, url) => {
      if (parseNavigable(url)) return
      event.preventDefault()
      this.openExternal(url)
    })

    // Permission policy: grant exactly what a fresh Chrome grants without a
    // prompt and deny everything else — applied to BOTH actual requests and
    // navigator.permissions.query checks. The check handler matters for stealth:
    // Electron otherwise answers every check "granted", which is impossible in a
    // real Chrome (camera+mic+geolocation+notifications all granted, unprompted)
    // and flags the browser as automated. Both handlers share one policy so the
    // queried state and the request outcome always agree. Camera/mic/geolocation
    // stay denied — a content viewer must not silently grant them.
    wc.session.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(isDefaultGrantedPermission(permission)),
    )
    wc.session.setPermissionCheckHandler((_wc, permission) => isDefaultGrantedPermission(permission))
  }

  private openExternal(url: string) {
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe).catch(() => {})
  }

  private async loadInternal(url: string) {
    // loadURL rejects on aborted/failed loads (e.g. a superseding navigation);
    // the did-fail-load handler already surfaces errors, so swallow here.
    try {
      await this.wc.loadURL(url)
    } catch {
      /* surfaced via did-fail-load */
    }
  }

  state(): BrowserState {
    const wc = this.wc
    return deriveBrowserState({
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      favicon: this.favicon,
    })
  }

  private emitState() {
    if (this.destroyed) return
    const payload = { target: rendererTarget(this.target), state: this.state() }
    for (const win of this.stateWindows()) win.webContents.send(BROWSER_STATE_CHANNEL, payload)
  }

  // A draft is window-private, so its state goes only to the owner window. A
  // conversation's state goes to every window: panels showing that conversation
  // elsewhere must stay current, and a view driven before it was ever displayed
  // has no host window to report through.
  private stateWindows(): BrowserWindow[] {
    const owner = draftWindowID(this.target)
    if (owner !== null) {
      const win = BrowserWindow.fromId(owner)
      return win && !win.isDestroyed() ? [win] : []
    }
    return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  }

  async navigate(input: string) {
    const url = parseNavigable(input)
    if (!url) return
    await this.loadInternal(url)
  }

  goBack() {
    if (this.wc.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack()
  }

  goForward() {
    if (this.wc.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward()
  }

  reload() {
    this.wc.reload()
  }

  stop() {
    this.wc.stop()
  }

  /**
   * Show this conversation's view in `win` at `rect`. Only a `claim` push may
   * take the display from another window — the loser's renderer is told via
   * DISPLAY_TAKEN so its panel shows a placeholder; a geometry tick from a
   * non-host window is dropped (see displayDecision). Returns whether the view
   * is now displayed in `win`, so the renderer keeps claiming until it is.
   */
  display(win: BrowserWindow, rect: BrowserViewLayout["rect"], claim: boolean): boolean {
    if (this.destroyed || win.isDestroyed()) return false
    if (this.host !== win) {
      const hasLiveHost = this.host !== null && !this.host.isDestroyed()
      const decision = displayDecision({ isHost: false, hasLiveHost, claim })
      if (decision === "drop") return false
      if (decision === "takeover" && this.host) {
        this.host.contentView.removeChildView(this.view)
        this.host.webContents.send(BROWSER_DISPLAY_TAKEN_CHANNEL, { target: rendererTarget(this.target) })
      }
      win.contentView.addChildView(this.view)
      this.host = win
    }
    this.view.setBounds(computeViewBounds(rect, win.webContents.zoomFactor))
    this.view.setVisible(true)
    return true
  }

  /** Hide the view — only honored from its current display owner. */
  hideFor(win: BrowserWindow) {
    if (this.host !== win) return
    this.view.setVisible(false)
  }

  /**
   * The display window is going away: detach the view so it survives (views
   * are conversation-owned, not window-owned). Keeps the default/last bounds;
   * the next display() re-attaches.
   */
  releaseHost(win: BrowserWindow) {
    if (this.host !== win) return
    if (!win.isDestroyed()) win.contentView.removeChildView(this.view)
    this.host = null
    this.view.setVisible(false)
  }

  // Reflect a partition-wide data clear: reload so the page shows its signed-out
  // state immediately. A first navigation still in flight was sent with the
  // pre-clear cookies, so defer one reload until it commits — otherwise it lands
  // as stale signed-in content with no follow-up. No-op when idle with no page.
  reloadIfLoaded() {
    if (this.destroyed || this.wc.isDestroyed()) return
    const action = clearDataReloadAction({ hasPage: this.state().hasPage, loading: this.wc.isLoading() })
    if (action === "now") {
      this.wc.reload()
    } else if (action === "defer") {
      this.wc.once("did-stop-loading", () => {
        if (this.destroyed || this.wc.isDestroyed()) return
        this.wc.reload()
      })
    }
  }

  /**
   * Bring up (or reuse) the CDP automation bridge over this view's WebContents
   * and return its sealed, main-process-only endpoint.
   */
  async attachAutomation(): Promise<AutomationEndpoint> {
    // A lazily-created view that has never loaded a document has no renderer
    // process, and debugger commands stall forever instead of failing — the
    // client's connect-time Page.enable would eat its whole 30s CDP timeout.
    // Commit about:blank first so the CDP session always has a live target
    // (the UI treats about: as "no page", and the probe maps it to no URL).
    // Direct loadURL: loadInternal is for page navigations and rejects
    // non-web schemes.
    if (!this.wc.getURL() && !this.wc.isDestroyed()) {
      try {
        await this.wc.loadURL("about:blank")
      } catch {
        /* a racing real navigation superseding this provides a document too */
      }
    }
    if (!this.automation) this.automation = new CdpBridge(this.wc)
    const endpoint = await this.automation.start()
    // A driven conversation may not be displayed anywhere: hold background
    // throttling off so timers and rendering keep full speed, restoring the
    // previous value on detach (throttling affects same-window frame drawing
    // and the Page Visibility API, so never blindly restore `true`).
    if (this.throttlingBefore === null && !this.wc.isDestroyed()) {
      this.throttlingBefore = this.wc.getBackgroundThrottling()
      this.wc.setBackgroundThrottling(false)
    }
    return endpoint
  }

  async detachAutomation() {
    await this.automation?.stop()
    this.automation = null
    if (this.throttlingBefore !== null && !this.wc.isDestroyed()) {
      this.wc.setBackgroundThrottling(this.throttlingBefore)
      this.throttlingBefore = null
    }
  }

  destroy() {
    if (this.destroyed) return
    // Final state push BEFORE teardown: the renderer panel outlives the view
    // (it survives tab close and route changes), so without this it would keep
    // showing stale hasPage/url for a page that no longer exists.
    const empty = deriveBrowserState({
      url: "",
      title: "",
      canGoBack: false,
      canGoForward: false,
      loading: false,
      favicon: null,
    })
    const payload = { target: rendererTarget(this.target), state: empty }
    for (const win of this.stateWindows()) win.webContents.send(BROWSER_STATE_CHANNEL, payload)
    this.destroyed = true
    // Tear down the ws bridge; the debugger itself detaches with wc.close() below.
    void this.automation?.stop()
    this.automation = null
    if (this.host && !this.host.isDestroyed()) this.host.contentView.removeChildView(this.view)
    this.host = null
    if (!this.wc.isDestroyed()) this.wc.close()
  }
}
