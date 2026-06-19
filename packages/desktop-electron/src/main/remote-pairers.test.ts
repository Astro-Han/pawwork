import { expect, mock, spyOn, test } from "bun:test"
import { WeChatApiError, WeChatClient } from "@opencode-ai/remote-bridge/platforms/wechat/client"

// WeChatPairer.pair drives the QR login loop directly over WeChatClient: mint a code,
// show it, poll status, and on expiry re-mint rather than dead-end. Spy the client's
// two network methods (so no HTTP) and mock the QR encoder (so no real PNG); the rest
// of the client module — incl. WeChatApiError, which the pairer's instanceof check
// uses — stays real.
mock.module("qrcode", () => ({ toDataURL: async () => "data:image/png;base64,FAKE" }))

let qrCalls = 0
let qrThrow: unknown = null
let statusResults: unknown[] = []

spyOn(WeChatClient.prototype, "getBotQrcode").mockImplementation(async () => {
  qrCalls++
  if (qrThrow) throw qrThrow
  return { qrcode: `QR${qrCalls}`, qrcodeUrl: `https://liteapp.weixin.qq.com/q/${qrCalls}` }
})
spyOn(WeChatClient.prototype, "getQrcodeStatus").mockImplementation(async () => {
  const next = statusResults.shift()
  if (next && typeof next === "object" && "throw" in next) throw (next as { throw: unknown }).throw
  return (next as any) ?? { status: "waiting" }
})

const { buildRemotePairers } = await import("./remote-pairers.ts")
const wechatPairer = () => buildRemotePairers().find((p) => p.platform === "wechat")!

function reset() {
  qrCalls = 0
  qrThrow = null
  statusResults = []
}

test("re-mints the QR on expiry, then resolves to the scanned account", async () => {
  reset()
  statusResults = [
    { status: "expired" },
    { status: "confirmed", botToken: "tok", baseURL: "https://r2.ilinkai.weixin.qq.com", userId: "u@im.wechat" },
  ]
  const emits: any[] = []
  const account = await wechatPairer().pair({}, (e) => emits.push(e), new AbortController().signal)

  expect(account).toEqual({
    platform: "wechat",
    botToken: "tok",
    baseURL: "https://r2.ilinkai.weixin.qq.com",
    allowFrom: "u@im.wechat",
  })
  expect(qrCalls).toBe(2) // initial mint + one re-mint after expiry
  expect(emits).toHaveLength(2) // a QR is shown for each minted code, not just the first
  expect(emits.every((e) => e.phase === "qr" && e.platform === "wechat" && e.image.startsWith("data:image/png"))).toBe(
    true,
  )
})

test("surfaces a real API error as a thrown failure", async () => {
  reset()
  statusResults = [{ throw: new WeChatApiError("/ilink/bot/get_qrcode_status", 200, -1, "scan rejected") }]
  await expect(wechatPairer().pair({}, () => {}, new AbortController().signal)).rejects.toThrow("scan rejected")
})

test("keeps polling past a transient (non-API) error", async () => {
  reset()
  statusResults = [
    { throw: new Error("ECONNRESET") }, // transient blip mid-scan — not terminal
    { status: "confirmed", botToken: "tok", baseURL: "https://r2.ilinkai.weixin.qq.com", userId: "u@im.wechat" },
  ]
  const account = await wechatPairer().pair({}, () => {}, new AbortController().signal)
  expect(account?.platform).toBe("wechat") // the blip did not abort the flow
})

test("wraps an unreachable service while minting the QR", async () => {
  reset()
  qrThrow = new WeChatApiError("/ilink/bot/get_bot_qrcode", 500, undefined, "down")
  await expect(wechatPairer().pair({}, () => {}, new AbortController().signal)).rejects.toThrow("could not reach WeChat")
})

test("returns null when aborted before the scan confirms", async () => {
  reset()
  const ac = new AbortController()
  ac.abort()
  expect(await wechatPairer().pair({}, () => {}, ac.signal)).toBeNull()
})
