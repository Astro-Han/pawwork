import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

// The connect dialog auto-approves WeChat (the scan + in-app confirm IS the
// authorization) but holds Telegram at a manual Allow so the user vets the captured
// sender. That asymmetry is the most security-sensitive line in the flow, so lock it:
// a `captured` event must fire confirmPairing exactly once for WeChat and never for
// Telegram. Rendered in a browser subprocess (no output ⇒ pass) like the other
// render-behavior checks in this package.
const autoApproveCheck = String.raw`
import { mock } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

globalThis.React = {
  createElement(type, props, ...children) {
    // Unwrap a lone child so Solid control-flow (For/Show) that takes a single
    // function child receives the function, not a one-element array.
    const kids = children.length <= 1 ? children[0] : children
    if (typeof type === "function") return type({ ...(props ?? {}), children: kids })
    return kids
  },
}

let pairingHandler
const confirmCalls = []
const startCalls = []
window.api = {
  remote: {
    onPairing: (handler) => {
      pairingHandler = handler
      return () => {}
    },
    startPairing: (platform) => {
      startCalls.push(platform)
      return Promise.resolve()
    },
    confirmPairing: (platform) => {
      confirmCalls.push(platform)
      return Promise.resolve()
    },
    cancelPairing: () => Promise.resolve(),
  },
}

mock.module("@opencode-ai/ui/button", () => ({ Button: (props) => props.children }))
mock.module("@opencode-ai/ui/dialog", () => ({ Dialog: (props) => props.children }))
mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
mock.module("@opencode-ai/ui/spinner", () => ({ Spinner: () => null }))
mock.module("@opencode-ai/ui/text-field", () => ({ TextField: () => null }))
mock.module("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: () => {} }) }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key) => key, intl: () => "en-US" }) }))
mock.module("@/pages/remote/platform-marks", () => ({ PlatformMark: () => null }))

const { DialogConnectRemote } = await import("./src/pages/remote/remote-connect-dialog.tsx")

// WeChat: opens straight into the QR flow and auto-confirms on capture.
const wechatRoot = document.createElement("div")
const disposeWeChat = render(() => createComponent(DialogConnectRemote, { platform: "wechat" }), wechatRoot)
assert(startCalls.includes("wechat"), "wechat should auto-start pairing on mount")
assert(typeof pairingHandler === "function", "dialog should register a pairing handler")
pairingHandler({ phase: "qr", platform: "wechat", image: "data:image/png;base64,AA==" })
assert(confirmCalls.length === 0, "no confirm before captured")
pairingHandler({ phase: "captured", platform: "wechat", identity: { id: "u@im.wechat", name: "Alice" } })
assert(
  confirmCalls.length === 1 && confirmCalls[0] === "wechat",
  "wechat captured must auto-confirm exactly once, got " + JSON.stringify(confirmCalls),
)
disposeWeChat()

// Telegram: captured stays at the manual Allow step — no auto-confirm.
pairingHandler = undefined
confirmCalls.length = 0
const telegramRoot = document.createElement("div")
const disposeTelegram = render(() => createComponent(DialogConnectRemote, { platform: "telegram" }), telegramRoot)
assert(typeof pairingHandler === "function", "telegram dialog should register a pairing handler")
pairingHandler({ phase: "captured", platform: "telegram", identity: { id: "123", name: "Bob" } })
assert(confirmCalls.length === 0, "telegram captured must NOT auto-confirm, got " + JSON.stringify(confirmCalls))
disposeTelegram()
`

describe("DialogConnectRemote auto-approve", () => {
  test("auto-confirms WeChat on capture but holds Telegram for manual approval", () => {
    runBrowserCheck(autoApproveCheck)
  })
})
