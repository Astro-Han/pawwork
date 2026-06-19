import { expect, test } from "bun:test"
import { WeChatApiError, type WeChatClient, type WeChatLoginStatus, type WeChatQrcode } from "./client.ts"
import { pollWeChatLogin, startWeChatLogin, WeChatLoginError } from "./login.ts"

// login.ts is the WeChat pairing primitive (the analog of Telegram's captureFirstSender):
// it shapes the iLink device flow — mint QR, poll until confirmed — behind an injectable
// client so the start/poll mapping is unit-tested without the live service.

/** A WeChatClient stand-in exposing only the two methods login.ts calls. */
function fakeClient(over: {
  getBotQrcode?: () => Promise<WeChatQrcode>
  getQrcodeStatus?: () => Promise<WeChatLoginStatus>
}): WeChatClient {
  return over as unknown as WeChatClient
}

test("startWeChatLogin returns the QR handle and URL to encode", async () => {
  const client = fakeClient({
    getBotQrcode: async () => ({ qrcode: "QR1", qrcodeUrl: "https://liteapp.weixin.qq.com/q/abc?qrcode=QR1" }),
  })
  expect(await startWeChatLogin({ client })).toEqual({
    qrcode: "QR1",
    qrcodeUrl: "https://liteapp.weixin.qq.com/q/abc?qrcode=QR1",
  })
})

test("startWeChatLogin rejects an empty QR response as a login error", async () => {
  const client = fakeClient({ getBotQrcode: async () => ({ qrcode: "", qrcodeUrl: "" }) })
  await expect(startWeChatLogin({ client })).rejects.toBeInstanceOf(WeChatLoginError)
})

test("startWeChatLogin wraps an unreachable service as a login error", async () => {
  const client = fakeClient({
    getBotQrcode: async () => {
      throw new Error("network down")
    },
  })
  await expect(startWeChatLogin({ client })).rejects.toThrow("could not reach WeChat")
})

test("pollWeChatLogin maps confirmed to done with token, base url, and user id", async () => {
  const client = fakeClient({
    getQrcodeStatus: async () => ({
      status: "confirmed",
      botToken: "tok",
      baseURL: "https://r2.ilinkai.weixin.qq.com",
      userId: "u@im.wechat",
    }),
  })
  expect(await pollWeChatLogin("QR1", { client })).toEqual({
    status: "done",
    botToken: "tok",
    baseURL: "https://r2.ilinkai.weixin.qq.com",
    userId: "u@im.wechat",
  })
})

test("pollWeChatLogin maps expired and waiting", async () => {
  const expired = fakeClient({ getQrcodeStatus: async () => ({ status: "expired" }) })
  expect(await pollWeChatLogin("QR1", { client: expired })).toEqual({ status: "expired" })
  const waiting = fakeClient({ getQrcodeStatus: async () => ({ status: "waiting" }) })
  expect(await pollWeChatLogin("QR1", { client: waiting })).toEqual({ status: "pending" })
})

test("pollWeChatLogin surfaces a real API error so a dead QR isn't spun forever", async () => {
  const client = fakeClient({
    getQrcodeStatus: async () => {
      throw new WeChatApiError("/ilink/bot/get_qrcode_status", 500, undefined, "boom")
    },
  })
  expect(await pollWeChatLogin("QR1", { client })).toEqual({
    status: "error",
    message: expect.stringContaining("boom"),
  })
})

test("pollWeChatLogin treats a long-poll timeout as keep-waiting", async () => {
  const client = fakeClient({
    getQrcodeStatus: async () => {
      const err = new Error("timed out")
      err.name = "TimeoutError"
      throw err
    },
  })
  expect(await pollWeChatLogin("QR1", { client })).toEqual({ status: "pending" })
})
