import { expect, test } from "bun:test"
import { isFatalWeChatError, WeChatApiError, WeChatClient } from "./client.ts"

type Route = (req: Request, url: URL) => Response | Promise<Response>

function mockServer(route: Route) {
  const server = Bun.serve({ port: 0, fetch: (req) => route(req, new URL(req.url)) })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

test("getBotQrcode returns the QR handle and the login URL to encode", async () => {
  const server = mockServer((_req, url) => {
    expect(url.pathname).toBe("/ilink/bot/get_bot_qrcode")
    expect(url.searchParams.get("bot_type")).toBe("3")
    // The live field carries a liteapp URL, not an image — the caller QR-encodes it.
    return json({ qrcode: "QR123", qrcode_img_content: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=QR123" })
  })
  try {
    const qr = await new WeChatClient({ baseURL: server.url }).getBotQrcode()
    expect(qr).toEqual({ qrcode: "QR123", qrcodeUrl: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=QR123" })
  } finally {
    server.stop()
  }
})

test("getQrcodeStatus reports waiting, expired, then confirmed with token + base url + user id", async () => {
  let calls = 0
  const server = mockServer(() => {
    calls++
    if (calls === 1) return json({ status: "wait" })
    if (calls === 2) return json({ status: "expired" })
    return json({
      status: "confirmed",
      bot_token: "tok_abc",
      baseurl: "https://r2.ilinkai.weixin.qq.com",
      ilink_user_id: "u@im.wechat",
    })
  })
  try {
    const client = new WeChatClient({ baseURL: server.url })
    expect(await client.getQrcodeStatus("QR123")).toEqual({ status: "waiting" })
    expect(await client.getQrcodeStatus("QR123")).toEqual({ status: "expired" })
    expect(await client.getQrcodeStatus("QR123")).toEqual({
      status: "confirmed",
      botToken: "tok_abc",
      baseURL: "https://r2.ilinkai.weixin.qq.com",
      userId: "u@im.wechat",
    })
  } finally {
    server.stop()
  }
})

test("getUpdates normalizes messages and carries the auth + uin headers", async () => {
  let authSeen = ""
  let typeSeen = ""
  let uinSeen = ""
  let bodySeen: any
  const server = mockServer(async (req) => {
    authSeen = req.headers.get("authorization") ?? ""
    typeSeen = req.headers.get("authorizationtype") ?? ""
    uinSeen = req.headers.get("x-wechat-uin") ?? ""
    bodySeen = await req.json()
    return json({
      ret: 0,
      get_updates_buf: "cursor-2",
      msgs: [
        {
          from_user_id: "u@im.wechat",
          to_user_id: "b@im.bot",
          message_type: 1,
          message_state: 2,
          context_token: "ctx-1",
          item_list: [{ type: 1, text_item: { text: "hi" } }],
        },
      ],
    })
  })
  try {
    const updates = await new WeChatClient({ baseURL: server.url, botToken: "tok_abc" }).getUpdates("cursor-1")
    expect(updates.cursor).toBe("cursor-2")
    expect(updates.messages).toHaveLength(1)
    expect(updates.messages[0]).toMatchObject({ fromUserId: "u@im.wechat", contextToken: "ctx-1" })
    expect(updates.messages[0].items[0]).toEqual({ type: 1, text: "hi" })
    expect(authSeen).toBe("Bearer tok_abc")
    expect(typeSeen).toBe("ilink_bot_token")
    expect(uinSeen).not.toBe("")
    expect(bodySeen.get_updates_buf).toBe("cursor-1")
  } finally {
    server.stop()
  }
})

test("sendMessage posts the iLink envelope with the context token", async () => {
  let body: any
  const server = mockServer(async (req) => {
    body = await req.json()
    return json({ ret: 0 })
  })
  try {
    await new WeChatClient({ baseURL: server.url, botToken: "t" }).sendMessage("u@im.wechat", "ctx-9", "done")
    expect(body.msg).toMatchObject({ to_user_id: "u@im.wechat", message_type: 2, message_state: 2, context_token: "ctx-9" })
    expect(body.msg.item_list[0]).toEqual({ type: 1, text_item: { text: "done" } })
  } finally {
    server.stop()
  }
})

test("a non-zero ret raises WeChatApiError; 401 is fatal", async () => {
  const server = mockServer(() => json({ ret: -2, errmsg: "rate limited" }))
  try {
    await expect(new WeChatClient({ baseURL: server.url, botToken: "t" }).sendMessage("u", "c", "x")).rejects.toThrow(
      "rate limited",
    )
  } finally {
    server.stop()
  }
  const unauthorized = mockServer(() => new Response("nope", { status: 401 }))
  try {
    let caught: unknown
    await new WeChatClient({ baseURL: unauthorized.url, botToken: "bad" }).getUpdates("").catch((e) => (caught = e))
    expect(caught).toBeInstanceOf(WeChatApiError)
    expect(isFatalWeChatError(caught)).toBe(true)
  } finally {
    unauthorized.stop()
  }
})
