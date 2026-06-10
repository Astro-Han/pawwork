import type { BrowserWindow } from "electron"
import type { AutomationEndpoint } from "./cdp-bridge"
import { BrowserViewController } from "./controller"

/**
 * Main-process registry of embedded-browser controllers, keyed by window id.
 * Shared by the renderer IPC layer (registerBrowserIpc) and the agent
 * automation resolver — both run in the main process, so the CDP endpoint and
 * secret produced here are handed back as same-process values and never cross
 * renderer IPC or preload. The registry never exposes a controller's private
 * WebContents; automation goes through the controller's own attach/detach.
 */
class BrowserControllerRegistry {
  private readonly controllers = new Map<number, BrowserViewController>()

  /** Get or lazily create the controller for a window, wiring its teardown. */
  ensure(win: BrowserWindow): BrowserViewController {
    // Capture the id now: by the time 'closed' fires the BrowserWindow is
    // destroyed and reading win.id throws "Object has been destroyed".
    const winId = win.id
    let controller = this.controllers.get(winId)
    if (!controller) {
      controller = new BrowserViewController(win)
      this.controllers.set(winId, controller)
      win.once("closed", () => {
        this.controllers.get(winId)?.destroy()
        this.controllers.delete(winId)
      })
    }
    return controller
  }

  get(winId: number): BrowserViewController | undefined {
    return this.controllers.get(winId)
  }

  all(): BrowserViewController[] {
    return [...this.controllers.values()]
  }

  /**
   * Bring up the CDP bridge for a window's embedded view and return its sealed
   * endpoint. PR2 layers session→window selection on top of this; here the
   * caller passes the already-resolved window.
   */
  attachForWindow(win: BrowserWindow): Promise<AutomationEndpoint> {
    return this.ensure(win).attachAutomation()
  }

  async detachForWindow(winId: number): Promise<void> {
    await this.controllers.get(winId)?.detachAutomation()
  }
}

/** Single main-process instance. */
export const browserControllers = new BrowserControllerRegistry()
