/**
 * The loopback leg of the authorization code flow: a server on 127.0.0.1 that
 * receives the redirect, checks the state it issued, and settles exactly once.
 *
 * The port is chosen by the system. That makes the redirect URI differ per
 * attempt, which matters to the authorization server's registration, so the
 * provider drops a registration whose recorded redirect URI no longer matches
 * rather than sending a URI the server never approved.
 */
import { createServer } from "node:http"

const CALLBACK_PATH = "/mcp/oauth/callback"
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

const PAGE = (title, detail, titleZh, detailZh) =>
  "<!doctype html><meta charset=utf-8><title>" +
  title +
  "</title><body style=\"font:16px system-ui;padding:3rem;max-width:32rem;margin:auto\"><h1 style=\"font-size:1.25rem\">" +
  title +
  "</h1><p>" +
  detail +
  "</p><p lang=zh-CN>" +
  titleZh +
  "。" +
  detailZh +
  "</p></body>"

/**
 * @param options.state - The state this attempt issued; a redirect carrying
 * anything else is refused.
 * @param options.timeoutMs - How long to wait for the human.
 * @returns The redirect URI to register, a promise for the one settled result,
 * and a way to stop waiting.
 */
export async function startCallbackServer({ state, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let settle
  const settled = new Promise((resolve) => {
    settle = resolve
  })
  let done = false
  const finish = (result) => {
    if (done) return
    done = true
    clearTimeout(timer)
    settle(result)
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Not found", "This address only serves the PawWork authorization callback.", "页面不存在", "这个地址只用于 PawWork 的授权回调"))
      return
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization failed", "This callback does not belong to the request PawWork started.", "授权失败", "这个回调不属于 PawWork 发起的授权请求"))
      return
    }
    const error = url.searchParams.get("error")
    if (error !== null) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization was not completed", "PawWork did not receive permission. You can close this window and try again.", "授权未完成", "PawWork 没有获得授权，可以关闭本窗口后重试"))
      finish({ error: error === "access_denied" ? "access_denied" : "authorization_failed" })
      return
    }
    const code = url.searchParams.get("code")
    if (code === null || code.length === 0) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization failed", "The redirect carried no authorization code.", "授权失败", "重定向中没有携带授权码"))
      finish({ error: "missing_code" })
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Authorization received", "Go back to PawWork to see the connection result. You can close this window.", "已收到授权", "回到 PawWork 查看连接结果，可以关闭本窗口"))
    finish({ code })
  })

  const timer = setTimeout(() => finish({ error: "timeout" }), timeoutMs)
  timer.unref?.()

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("mcp-oauth: callback server bound no port")

  return {
    redirectUrl: "http://127.0.0.1:" + address.port + CALLBACK_PATH,
    settled,
    close() {
      finish({ error: "closed" })
      // `close` alone waits out keep-alive sockets the browser leaves open.
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
