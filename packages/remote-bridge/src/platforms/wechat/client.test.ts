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

test("getBotQrcode rejects a response with no QR rather than handing back a blank code", async () => {
  const server = mockServer(() => json({ qrcode: "", qrcode_img_content: "" }))
  try {
    await expect(new WeChatClient({ baseURL: server.url }).getBotQrcode()).rejects.toBeInstanceOf(WeChatApiError)
  } finally {
    server.stop()
  }
})

test("getQrcodeStatus maps its own long-poll timeout to still-waiting", async () => {
  // The status call long-holds; when the client-side timeout fires (here forced via a
  // short external AbortSignal.timeout while the server stalls) it means "no change
  // yet, poll again" — a TimeoutError, not a failure.
  const server = mockServer(async () => {
    await new Promise((r) => setTimeout(r, 300))
    return json({ status: "wait" })
  })
  try {
    const status = await new WeChatClient({ baseURL: server.url }).getQrcodeStatus("QR1", AbortSignal.timeout(15))
    expect(status).toEqual({ status: "waiting" })
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

test("getQrcodeStatus throws on a confirmed response missing the token or user id", async () => {
  // confirmed is terminal; an incomplete one won't get better by polling again, so it
  // must surface as an error (the user waits forever otherwise) — not fall to waiting.
  for (const body of [
    { status: "confirmed", bot_token: "", ilink_user_id: "u@im.wechat", baseurl: "https://r2.ilinkai.weixin.qq.com" },
    { status: "confirmed", bot_token: "tok_abc", ilink_user_id: "", baseurl: "https://r2.ilinkai.weixin.qq.com" },
  ]) {
    const server = mockServer(() => json(body))
    try {
      await expect(new WeChatClient({ baseURL: server.url }).getQrcodeStatus("QR123")).rejects.toThrow(
        "incomplete confirm response",
      )
    } finally {
      server.stop()
    }
  }
})

test("getQrcodeStatus rejects a confirmed response whose baseurl isn't a valid https origin", async () => {
  // baseurl is persisted and trusted for every later call, so a non-https / malformed
  // host must not be saved.
  for (const baseurl of ["http://r2.ilinkai.weixin.qq.com", "javascript:alert(1)", "not a url", "   "]) {
    const server = mockServer(() =>
      json({ status: "confirmed", bot_token: "tok_abc", ilink_user_id: "u@im.wechat", baseurl }),
    )
    try {
      await expect(new WeChatClient({ baseURL: server.url }).getQrcodeStatus("QR123")).rejects.toThrow(
        "incomplete confirm response",
      )
    } finally {
      server.stop()
    }
  }
})

test("getUpdates normalizes messages and carries the auth + uin + app headers", async () => {
  let authSeen = ""
  let typeSeen = ""
  let uinSeen = ""
  let appIdSeen = ""
  let appVerSeen = ""
  let bodySeen: any
  const server = mockServer(async (req) => {
    authSeen = req.headers.get("authorization") ?? ""
    typeSeen = req.headers.get("authorizationtype") ?? ""
    uinSeen = req.headers.get("x-wechat-uin") ?? ""
    appIdSeen = req.headers.get("ilink-app-id") ?? ""
    appVerSeen = req.headers.get("ilink-app-clientversion") ?? ""
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
    // The app id + version (header and base_info) are what mark a send as a live bot;
    // omitting them is the silent-drop bug, so lock them.
    expect(appIdSeen).toBe("bot")
    expect(appVerSeen).not.toBe("")
    expect(bodySeen.get_updates_buf).toBe("cursor-1")
    expect(typeof bodySeen.base_info?.channel_version).toBe("string")
    expect(typeof bodySeen.base_info?.bot_agent).toBe("string")
  } finally {
    server.stop()
  }
})

test("sendMessage posts a FINISH envelope with from_user_id, context token, and base_info", async () => {
  let body: any
  const server = mockServer(async (req) => {
    body = await req.json()
    return json({ ret: 0 })
  })
  try {
    await new WeChatClient({ baseURL: server.url, botToken: "t" }).sendMessage("u@im.wechat", "ctx-9", "done")
    expect(body.msg).toMatchObject({
      from_user_id: "",
      to_user_id: "u@im.wechat",
      message_type: 2,
      message_state: 2,
      context_token: "ctx-9",
    })
    expect(body.msg.item_list[0]).toEqual({ type: 1, text_item: { text: "done" } })
    expect(typeof body.msg.client_id).toBe("string")
    expect(body.msg.client_id.length).toBeGreaterThan(0)
    expect(body.base_info).toBeDefined()
  } finally {
    server.stop()
  }
})

test("sendMessage mints a fresh client_id per call", async () => {
  const ids: string[] = []
  const server = mockServer(async (req) => {
    const body: any = await req.json()
    ids.push(body.msg.client_id)
    return json({ ret: 0 })
  })
  try {
    const client = new WeChatClient({ baseURL: server.url, botToken: "t" })
    await client.sendMessage("u", "ctx", "one")
    await client.sendMessage("u", "ctx", "two")
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  } finally {
    server.stop()
  }
})

test("notifyStart POSTs its endpoint with base_info", async () => {
  const seen: { path: string; body: any }[] = []
  const server = mockServer(async (req, url) => {
    seen.push({ path: url.pathname, body: await req.json() })
    return json({ ret: 0 })
  })
  try {
    await new WeChatClient({ baseURL: server.url, botToken: "t" }).notifyStart()
    expect(seen.map((s) => s.path)).toEqual(["/ilink/bot/msg/notifystart"])
    expect(seen[0].body.base_info).toBeDefined()
  } finally {
    server.stop()
  }
})

test("a 2xx non-JSON body raises WeChatApiError instead of passing as empty success", async () => {
  // A proxy login page / HTML error returned with 200 must not be swallowed into {}.
  const server = mockServer(() => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }))
  try {
    const client = new WeChatClient({ baseURL: server.url, botToken: "t" })
    await expect(client.getUpdates("")).rejects.toThrow("invalid JSON response")
    await expect(client.getQrcodeStatus("QR1")).rejects.toThrow("invalid JSON response")
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
