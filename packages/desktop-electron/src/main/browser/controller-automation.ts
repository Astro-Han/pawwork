import type { BrowserWindow } from "electron"
import { BrowserViewController, draftKey } from "./controller"

/**
 * Main-process registry of embedded-browser controllers, keyed by the owning
 * conversation (root session id) or a window's Home draft (`draft:<windowID>`).
 * Shared by the renderer IPC layer (registerBrowserIpc) and the agent
 * automation host — both run in the main process, so the CDP endpoint and
 * secret produced here are handed back as same-process values and never cross
 * renderer IPC or preload. The registry never exposes a controller's private
 * WebContents; automation goes through the controller's own attach/detach.
 */
class BrowserControllerRegistry {
  private readonly controllers = new Map<string, BrowserViewController>()

  /** Get or lazily create the controller owned by a conversation or draft key. */
  ensure(key: string): BrowserViewController {
    let controller = this.controllers.get(key)
    if (!controller) {
      controller = new BrowserViewController(key)
      this.controllers.set(key, controller)
    }
    return controller
  }

  get(key: string): BrowserViewController | undefined {
    return this.controllers.get(key)
  }

  all(): BrowserViewController[] {
    return [...this.controllers.values()]
  }

  /**
   * Hand a window's Home draft to the session just created from it: the view
   * (page, history, automation) moves as-is, only the owner key changes. Must
   * complete before the renderer navigates to the session route, so the new
   * panel finds the adopted view instead of lazily creating an empty one.
   * Fails soft — no draft, or the session somehow already has a view — and
   * reports whether the adopted view has a page, so the caller opens the
   * browser tab in the new conversation only when there is something to show.
   */
  adoptDraft(windowID: number, sessionID: string): { adopted: boolean; hasPage: boolean } {
    const draft = this.controllers.get(draftKey(windowID))
    if (!draft || this.controllers.has(sessionID)) return { adopted: false, hasPage: false }
    this.controllers.delete(draftKey(windowID))
    this.controllers.set(sessionID, draft)
    draft.retarget(sessionID)
    return { adopted: true, hasPage: draft.state().hasPage }
  }

  /**
   * The window switched routes (renderer-reported DesktopContext): stop
   * displaying any view it no longer shows. This is the authoritative hide for
   * route changes — the renderer panel survives them without remounting, so it
   * can only address the NEW conversation by the time it reacts. The window's
   * draft survives only while the window is NOT on a conversation (a null
   * sessionID is the new-session page, where the draft panel lives).
   */
  syncWindowDisplay(win: BrowserWindow, sessionID: string | null) {
    for (const [key, controller] of this.controllers) {
      if (key === sessionID) continue
      if (sessionID === null && key === draftKey(win.id)) continue
      controller.hideFor(win)
    }
  }

  /**
   * A window is closing: conversation views it displayed detach and live on
   * (they are conversation-owned, not window-owned); the window's own draft
   * dies with it.
   */
  onWindowClosing(win: BrowserWindow) {
    for (const controller of this.controllers.values()) controller.releaseHost(win)
    const draft = draftKey(win.id)
    this.controllers.get(draft)?.destroy()
    this.controllers.delete(draft)
  }
}

/** Single main-process instance. */
export const browserControllers = new BrowserControllerRegistry()
