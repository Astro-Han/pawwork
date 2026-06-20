import { Flag } from "@opencode-ai/core/flag/flag"
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

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

const STATIC_MIME_TYPES: Record<string, string> = {
  aac: "audio/aac",
  avi: "video/x-msvideo",
  avif: "image/avif",
  av1: "video/av1",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  eot: "application/vnd.ms-fontobject",
  epub: "application/epub+zip",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  ics: "text/calendar; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  jsonld: "application/ld+json",
  map: "application/json",
  mid: "audio/x-midi",
  midi: "audio/x-midi",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  oga: "audio/ogg",
  ogv: "video/ogg",
  ogx: "application/ogg",
  opus: "audio/opus",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  rtf: "application/rtf",
  svg: "image/svg+xml; charset=utf-8",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/mp2t",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  weba: "audio/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xhtml: "application/xhtml+xml; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  zip: "application/zip",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  gltf: "model/gltf+json",
  glb: "model/gltf-binary",
}

function getStaticMimeType(file: string) {
  const match = file.match(/\.([a-zA-Z0-9]+?)$/)
  return match ? STATIC_MIME_TYPES[match[1]!.toLowerCase()] : undefined
}

function proxyRequestHeaders(request: Request) {
  const headers = new Headers(request.headers)
  headers.delete("accept-encoding")
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
  headers.set("host", "app.opencode.ai")
  return headers
}

function proxyResponseHeaders(response: Response) {
  const headers = new Headers(response.headers)
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header)
  }
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding")
    headers.delete("content-length")
  }
  return headers
}

export async function handleUIRequest(request: Request) {
  const embeddedWebUI = await embeddedUIPromise
  const path = new URL(request.url).pathname

  if (embeddedWebUI) {
    const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
    if (!match) return Response.json({ error: "Not Found" }, { status: 404 })

    if (await fs.exists(match)) {
      const mime = getStaticMimeType(match) ?? "text/plain"
      const headers = new Headers({ "content-type": mime })
      if (mime.startsWith("text/html")) {
        headers.set("content-security-policy", DEFAULT_CSP)
      }
      return new Response(new Uint8Array(await fs.readFile(match)), { headers })
    } else {
      return Response.json({ error: "Not Found" }, { status: 404 })
    }
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: proxyRequestHeaders(request),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    signal: request.signal,
  }
  if (init.body) init.duplex = "half"
  const response = await fetch(
    new Request(`https://app.opencode.ai${path}`, init),
  )
  const match = response.headers.get("content-type")?.includes("text/html")
    ? (await response.clone().text()).match(
        /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
      )
    : undefined
  const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
  const headers = proxyResponseHeaders(response)
  headers.set("content-security-policy", csp(hash))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
