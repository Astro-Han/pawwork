import { resolveAutomationController } from "../ipc/browser"

/**
 * Inject the controller-backed browser automation into the in-process opencode
 * server. The server's browser_* tools call BrowserBridge (a registrable port);
 * here in main — where the WebContentsView controllers live — we register the
 * concrete implementation. This is the inverse of the usual main -> server
 * direction: main hands an implementation down into the server.
 *
 * Each call resolves the focused (or only) window fresh, so the agent always
 * drives the window the user is looking at, and a window opened or closed later
 * needs no re-registration. Tools are gated out of the registry on non-desktop
 * clients, so this is the only place an implementation is ever registered.
 */
export async function registerBrowserAutomationBridge(): Promise<void> {
  const { BrowserBridge } = await import("virtual:opencode-server")
  BrowserBridge.register({
    navigate: ({ url }) => resolveAutomationController().navigateAndReport(url),
    screenshot: () => resolveAutomationController().captureScreenshot(),
    extract: ({ selector, maxChars }) => resolveAutomationController().extractText(selector, maxChars),
    waitFor: ({ selector, text, timeoutMs }) => resolveAutomationController().waitFor(selector, text, timeoutMs),
    click: ({ selector }) => resolveAutomationController().clickSelector(selector),
    type: ({ selector, text, submit }) => resolveAutomationController().typeText(selector, text, submit),
  })
}
