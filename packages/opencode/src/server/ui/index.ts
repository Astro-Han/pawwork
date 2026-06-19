import { Flag } from "@opencode-ai/core/flag/flag"
import { Hono } from "hono"
import { getMimeType } from "hono/utils/mime"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

export async function handleUIRequest(request: Request) {
  const embeddedWebUI = await embeddedUIPromise
  const path = new URL(request.url).pathname

  if (embeddedWebUI) {
    const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
    if (!match) return Response.json({ error: "Not Found" }, { status: 404 })

    if (await fs.exists(match)) {
      const mime = getMimeType(match) ?? "text/plain"
      const headers = new Headers({ "content-type": mime })
      if (mime.startsWith("text/html")) {
        headers.set("content-security-policy", DEFAULT_CSP)
      }
      return new Response(new Uint8Array(await fs.readFile(match)), { headers })
    } else {
      return Response.json({ error: "Not Found" }, { status: 404 })
    }
  }

  const headers = new Headers(request.headers)
  headers.set("host", "app.opencode.ai")
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    signal: request.signal,
  }
  if (init.body) init.duplex = "half"
  const response = await fetch(
    new Request(`https://app.opencode.ai${path}`, init),
  )
  const next = new Headers(response.headers)
  const match = response.headers.get("content-type")?.includes("text/html")
    ? (await response.clone().text()).match(
        /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
      )
    : undefined
  const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
  next.set("content-security-policy", csp(hash))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  })
}

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    return handleUIRequest(c.req.raw)
  })
