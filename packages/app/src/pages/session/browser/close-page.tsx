import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import type { useLanguage } from "@/context/language"
import type { BrowserBridge } from "@/context/platform"

/** Decide what the browser tab's close gesture does. Pure for tests. */
export function browserTabCloseAction(input: { hasPage: boolean; running: boolean }): "confirm" | "close" {
  return input.hasPage && input.running ? "confirm" : "close"
}

/**
 * Closing the browser tab is WYSIWYG: the chip's × promises "Close", so it
 * destroys the conversation's page — it does not merely hide it. Hiding has
 * its own gestures already (switching tabs, collapsing the panel). When an
 * agent task is running against a live page, confirm first: destroying the
 * page makes the agent's in-flight browser actions fail.
 *
 * The returned closure is the close gesture for BOTH paths (the chip × and
 * mod+w) — pass it to createCloseShellTabRouter so the two stay identical.
 */
export function createBrowserTabClose(deps: {
  bridge: () => BrowserBridge | undefined
  target: () => string
  running: () => boolean
  closeTab: () => void
  confirm: (proceed: () => void) => void
}): () => void {
  return () => {
    const bridge = deps.bridge()
    if (!bridge) {
      deps.closeTab()
      return
    }
    // Snapshot at gesture time: the confirm dialog may outlive a route change,
    // and re-reading deps.target() after one would destroy the page of
    // whatever conversation the user navigated to meanwhile.
    const target = deps.target()
    const close = () => {
      void bridge.closePage(target)
      deps.closeTab()
    }
    void bridge
      .getState(target)
      .then((state) => {
        if (browserTabCloseAction({ hasPage: state?.hasPage ?? false, running: deps.running() }) === "confirm") {
          deps.confirm(close)
        } else {
          close()
        }
      })
      // The probe only decides whether to confirm; its failure must not veto
      // the user's close.
      .catch(close)
  }
}

/** The confirm half of createBrowserTabClose, shared by both consumers. The
 *  copy names the conversation, not the window: pages are conversation-owned,
 *  so a close from any window kills the page everywhere it shows. */
export function showBrowserCloseConfirm(
  dialog: ReturnType<typeof useDialog>,
  language: ReturnType<typeof useLanguage>,
  proceed: () => void,
) {
  dialog.show(() => (
    <Dialog
      title={language.t("browser.closePage.title")}
      description={language.t("browser.closePage.description")}
      footer={
        <>
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              dialog.close()
              proceed()
            }}
          >
            {language.t("browser.closePage.confirm")}
          </Button>
        </>
      }
    />
  ))
}
