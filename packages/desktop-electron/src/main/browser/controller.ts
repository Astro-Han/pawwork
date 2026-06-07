import { WebContentsView, shell, type BrowserWindow } from "electron"
import type { BrowserState, BrowserViewLayout } from "@opencode-ai/app/desktop-api"
import { browserViewWebPreferences } from "./options"
import { computeViewBounds, deriveBrowserState, parseNavigable, safeExternalUrl } from "./logic"

export const BROWSER_STATE_CHANNEL = "browser:state"

/**
 * Owns one embedded browser per window: a WebContentsView painted over the
 * panel's content region. The view is a native layer above the DOM, so the
 * renderer drives its bounds/visibility via setView; navigation state is pushed
 * back over BROWSER_STATE_CHANNEL. Created lazily on first use, destroyed with
 * the window.
 */
export class BrowserViewController {
  private readonly view: WebContentsView
  private rect: BrowserViewLayout["rect"] | null = null
  private visible = false
  private favicon: string | null = null
  private destroyed = false

  constructor(private readonly win: BrowserWindow) {
    this.view = new WebContentsView({ webPreferences: browserViewWebPreferences() })
    this.view.setVisible(false)
    win.contentView.addChildView(this.view)
    this.wireEvents()
  }

  private get wc() {
    return this.view.webContents
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

    // Deny every permission request by default — a v1 content viewer should not
    // silently grant camera/mic/geolocation/etc. (the permission model for
    // agent-driven use is tracked separately in #1186 PR2).
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
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
    if (this.destroyed || this.win.isDestroyed()) return
    this.win.webContents.send(BROWSER_STATE_CHANNEL, this.state())
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

  setView(layout: BrowserViewLayout) {
    this.visible = layout.visible
    this.rect = layout.rect
    this.applyLayout()
  }

  private applyLayout() {
    if (this.destroyed || this.win.isDestroyed()) return
    if (!this.visible || !this.rect) {
      this.view.setVisible(false)
      return
    }
    this.view.setBounds(computeViewBounds(this.rect, this.win.webContents.zoomFactor))
    this.view.setVisible(true)
  }

  // Reflect a partition-wide data clear: reload so the page shows its
  // signed-out state immediately. No-op when no real page is loaded.
  reloadIfLoaded() {
    if (this.destroyed || this.wc.isDestroyed()) return
    if (this.state().hasPage) this.wc.reload()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.view)
    if (!this.wc.isDestroyed()) this.wc.close()
  }
}
