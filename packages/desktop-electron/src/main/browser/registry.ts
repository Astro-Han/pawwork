/**
 * Main-process registry of embedded-browser controllers, keyed by the owning
 * conversation (root session id) or a window's Home draft (`draft:<windowID>`).
 * Shared by the renderer IPC layer (registerBrowserIpc) and the agent
 * automation host — both run in the main process, so the CDP endpoint and
 * secret produced here are handed back as same-process values and never cross
 * renderer IPC or preload. The registry never exposes a controller's private
 * WebContents; automation goes through the controller's own attach/detach.
 *
 * The class is pure bookkeeping over an injected controller factory (no
 * electron import), so its lifecycle semantics — adoption, route-change
 * sweeps, window close, disposal — are pinned by plain unit tests. The
 * singleton wired to the real BrowserViewController lives in
 * controller-automation.ts.
 */

/** Registry key of a window's Home draft view (the only window-scoped views). */
export function draftKey(windowID: number): string {
  return `draft:${windowID}`
}

export function draftWindowID(ownerKey: string): number | null {
  return ownerKey.startsWith("draft:") ? Number(ownerKey.slice("draft:".length)) : null
}

/** Renderer-facing target of an owner key: drafts are window-private, so the
 *  renderer addresses its own draft as the literal "draft". */
export function rendererTarget(ownerKey: string): string {
  return draftWindowID(ownerKey) === null ? ownerKey : "draft"
}

/** The slice of BrowserWindow the registry reads; tests pass plain objects. */
export type RegistryWindow = { id: number }

/** What the registry needs from a controller — BrowserViewController in prod. */
export type OwnedBrowserView = {
  retarget(target: string): void
  hideFor(win: RegistryWindow): void
  releaseHost(win: RegistryWindow): void
  destroy(): void
  state(): { hasPage: boolean }
}

export class BrowserControllerRegistry<C extends OwnedBrowserView> {
  private readonly controllers = new Map<string, C>()

  constructor(private readonly create: (key: string) => C) {}

  /** Get or lazily create the controller owned by a conversation or draft key. */
  ensure(key: string): C {
    let controller = this.controllers.get(key)
    if (!controller) {
      controller = this.create(key)
      this.controllers.set(key, controller)
    }
    return controller
  }

  get(key: string): C | undefined {
    return this.controllers.get(key)
  }

  all(): C[] {
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
    // The target must be a session id, never a key in the draft namespace —
    // re-keying a view under another window's `draft:N` would make state and
    // display routing treat it as that window's private draft.
    if (draftWindowID(sessionID) !== null) return { adopted: false, hasPage: false }
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
  syncWindowDisplay(win: RegistryWindow, sessionID: string | null) {
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
  onWindowClosing(win: RegistryWindow) {
    for (const controller of this.controllers.values()) controller.releaseHost(win)
    const draft = draftKey(win.id)
    this.controllers.get(draft)?.destroy()
    this.controllers.delete(draft)
  }

  /**
   * The conversation is gone (session deleted or archived): destroy its view
   * outright. The complement of the lazy ensure() — without it, every
   * conversation that ever opened the embedded browser keeps a live
   * WebContentsView for the app lifetime. No-op for unknown keys.
   */
  dispose(key: string) {
    const controller = this.controllers.get(key)
    if (!controller) return
    this.controllers.delete(key)
    controller.destroy()
  }
}
