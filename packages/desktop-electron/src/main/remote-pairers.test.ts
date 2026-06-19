import { expect, mock, test } from "bun:test"

// WeChatPairer.pair drives the QR login loop: mint a code, show it, poll, and on
// expiry re-mint rather than dead-end. Mock the login primitive (so no network) and
// the QR encoder (so no real PNG) and assert the loop's control flow.
let startCalls = 0
let pollResults: Array<Record<string, unknown>> = []

mock.module("@opencode-ai/remote-bridge/platforms/wechat/login", () => ({
  startWeChatLogin: async () => {
    startCalls++
    return { qrcode: `QR${startCalls}`, qrcodeUrl: `https://liteapp.weixin.qq.com/q/${startCalls}` }
  },
  pollWeChatLogin: async () => pollResults.shift() ?? { status: "pending" },
}))
mock.module("qrcode", () => ({ toDataURL: async () => "data:image/png;base64,FAKE" }))

const { buildRemotePairers } = await import("./remote-pairers.ts")
const wechatPairer = () => buildRemotePairers().find((p) => p.platform === "wechat")!

test("re-mints the QR on expiry, then resolves to the scanned account", async () => {
  startCalls = 0
  pollResults = [
    { status: "expired" },
    { status: "done", botToken: "tok", baseURL: "https://r2.ilinkai.weixin.qq.com", userId: "u@im.wechat" },
  ]
  const emits: any[] = []
  const account = await wechatPairer().pair({}, (e) => emits.push(e), new AbortController().signal)

  expect(account).toEqual({
    platform: "wechat",
    botToken: "tok",
    baseURL: "https://r2.ilinkai.weixin.qq.com",
    allowFrom: "u@im.wechat",
  })
  expect(startCalls).toBe(2) // initial mint + one re-mint after expiry
  expect(emits).toHaveLength(2) // a QR is shown for each minted code, not just the first
  expect(emits.every((e) => e.phase === "qr" && e.platform === "wechat" && e.image.startsWith("data:image/png"))).toBe(
    true,
  )
})

test("surfaces a login error as a thrown failure", async () => {
  startCalls = 0
  pollResults = [{ status: "error", message: "scan rejected" }]
  await expect(wechatPairer().pair({}, () => {}, new AbortController().signal)).rejects.toThrow("scan rejected")
})

test("returns null when aborted before the scan confirms", async () => {
  startCalls = 0
  pollResults = [] // poll keeps returning "pending"
  const ac = new AbortController()
  ac.abort()
  expect(await wechatPairer().pair({}, () => {}, ac.signal)).toBeNull()
})
