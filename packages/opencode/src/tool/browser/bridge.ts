/**
 * BrowserBridge — the in-process port that lets the agent's browser tools drive
 * the Electron embedded browser (a WebContentsView).
 *
 * The embedded opencode server is imported in-process by Electron main
 * (`virtual:opencode-server`), so a tool calling the bridge is a direct
 * in-process call, not IPC. The concrete implementation lives in the desktop
 * main process — it owns the WebContentsView controllers — and is injected here
 * via `register()` at app startup. This is the inverse of the usual
 * main -> server calls: here main hands an implementation down into the server.
 *
 * Non-desktop clients (cli/app/headless) never register an implementation, and
 * the browser tools are gated out of the registry there. `get()` throws a clear
 * error if a tool is somehow reached without a registered implementation.
 *
 * Result shapes are plain JSON-serializable objects so the same contract holds
 * whether the call stays in-process or is ever proxied.
 */
export namespace BrowserBridge {
  export type NavigateResult = { url: string; title: string }
  export type ScreenshotResult = { mime: string; base64: string; width: number; height: number }
  export type ExtractResult = { url: string; title: string; text: string; truncated: boolean }
  export type WaitResult = { found: boolean; waitedMs: number; reason: "selector" | "text" | "timeout" }
  export type ClickResult = { matched: boolean; x: number; y: number }
  export type TypeResult = { matched: boolean; submitted: boolean }

  export interface Impl {
    navigate(input: { url: string }): Promise<NavigateResult>
    screenshot(): Promise<ScreenshotResult>
    extract(input: { selector?: string; maxChars: number }): Promise<ExtractResult>
    waitFor(input: { selector?: string; text?: string; timeoutMs: number }): Promise<WaitResult>
    click(input: { selector: string }): Promise<ClickResult>
    type(input: { selector?: string; text: string; submit: boolean }): Promise<TypeResult>
  }

  export const UNAVAILABLE_MESSAGE = "Browser automation is only available in the PawWork desktop app."

  let impl: Impl | undefined

  export function register(value: Impl) {
    impl = value
  }

  export function unregister() {
    impl = undefined
  }

  export function available(): boolean {
    return impl !== undefined
  }

  export function get(): Impl {
    if (!impl) throw new Error(UNAVAILABLE_MESSAGE)
    return impl
  }
}
