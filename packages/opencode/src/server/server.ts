import { adapter } from "#hono"
import { HTTPException } from "hono/http-exception"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"
import { Provider } from "@/provider"
import { Session } from "@/session"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { AutomationScheduler } from "@/automation/scheduler"
import { MDNS } from "./mdns"
import { ServerAuth } from "./auth"
import { initProjectors } from "./projectors"
import { createProductionHttpApiDispatcher, isProductionHttpApiRequest } from "./production-httpapi"
import { createProductionSpecialHandler } from "./production-special"
import { createWebSocketCompatibilityHost } from "./websocket-compatibility"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

initProjectors()

const log = Log.create({ service: "server" })
const PTY_CONNECT_PATH = /^\/pty\/[^/]+\/connect$/
const PROVIDER_AUTH_BAD_REQUEST = new Set([
  "ProviderAuthValidationFailed",
  "ProviderAuthOauthMissing",
  "ProviderAuthOauthCodeMissing",
  "ProviderAuthOauthCallbackFailed",
])

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch: (request: Request, env?: unknown) => Promise<Response>
  request: (input: string | Request, init?: RequestInit) => Promise<Response>
}

export const Default = lazy(() => create({}))

function corsOrigin(origin: string | null, opts: { cors?: string[] }) {
  if (!origin) return
  if (origin.startsWith("http://localhost:")) return origin
  if (origin.startsWith("http://127.0.0.1:")) return origin
  if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return origin
  if (opts.cors?.includes(origin)) return origin
}

function applyCors(request: Request, response: Response, opts: { cors?: string[] }) {
  const origin = corsOrigin(request.headers.get("origin"), opts)
  if (!origin) return response

  const headers = new Headers(response.headers)
  headers.set("access-control-allow-origin", origin)
  headers.append("vary", "Origin")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function corsPreflight(request: Request, opts: { cors?: string[] }) {
  const origin = corsOrigin(request.headers.get("origin"), opts)
  const headers = new Headers()
  if (origin) {
    headers.set("access-control-allow-origin", origin)
    headers.set("access-control-allow-methods", "GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS")
    const requestedHeaders = request.headers.get("access-control-request-headers")
    if (requestedHeaders) headers.set("access-control-allow-headers", requestedHeaders)
    headers.set("access-control-max-age", "86400")
    headers.append("vary", "Origin")
  }
  return new Response(null, { status: 204, headers })
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="opencode"',
      "content-type": "text/plain; charset=UTF-8",
    },
  })
}

function authorize(request: Request) {
  if (request.method === "OPTIONS") return

  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return

  const url = new URL(request.url)
  if (request.method === "GET" && PTY_CONNECT_PATH.test(url.pathname) && url.searchParams.get("ticket")) return

  const queryToken = url.searchParams.get("auth_token")
  const authHeader = request.headers.get("authorization")
  const header = queryToken ? "Basic " + queryToken : authHeader
  const match = header?.match(/^Basic\s+(.+)$/i)
  if (!match) return unauthorized()

  const decoded = Buffer.from(match[1], "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator === -1) return unauthorized()

  const config = {
    password: Option.some(password),
    username: Flag.OPENCODE_SERVER_USERNAME ?? "opencode",
  }
  const credentials = {
    username: decoded.slice(0, separator),
    password: Redacted.make(decoded.slice(separator + 1)),
  }
  if (!ServerAuth.authorized(credentials, config)) return unauthorized()
}

function errorResponse(error: unknown) {
  if (error instanceof NamedError) {
    const status =
      error instanceof NotFoundError
        ? 404
        : error instanceof Provider.ModelNotFoundError ||
            PROVIDER_AUTH_BAD_REQUEST.has(error.name) ||
            error.name.startsWith("Worktree")
          ? 400
          : 500
    if (!(error instanceof NotFoundError)) log.error("failed", { error })
    return Response.json(error.toObject(), { status })
  }
  log.error("failed", { error })
  if (error instanceof Session.BusyError) {
    return Response.json(new NamedError.Unknown({ message: error.message }).toObject(), { status: 409 })
  }
  if (error instanceof HTTPException) return error.getResponse()
  return Response.json(new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(), {
    status: 500,
  })
}

async function maybeCompress(request: Request, response: Response) {
  const url = new URL(request.url)
  if (!request.headers.get("accept-encoding")?.includes("gzip")) return response
  if (response.headers.has("content-encoding")) return response
  if (url.pathname === "/event" || url.pathname === "/global/event" || url.pathname === "/global/sync-event") {
    return response
  }
  if (request.method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(url.pathname)) return response
  if (!response.body || !("CompressionStream" in globalThis)) return response

  const headers = new Headers(response.headers)
  headers.set("content-encoding", "gzip")
  headers.delete("content-length")
  return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function create(opts: { cors?: string[] }) {
  const websocketCompatibilityHost = createWebSocketCompatibilityHost()
  let app: ServerApp
  const runtime = adapter.create(
    {
      fetch(request: Request, env?: unknown) {
        return app.fetch(request, env)
      },
    },
    websocketCompatibilityHost.app,
  )
  const websocketCompatibility = websocketCompatibilityHost.mount(runtime.upgradeWebSocket)
  const special = createProductionSpecialHandler({ websocketCompatibilityApp: websocketCompatibility })
  const dispatcher = createProductionHttpApiDispatcher(runtime.upgradeWebSocket, {
    specialHandler: special,
  })

  app = {
    async fetch(request, env) {
      const pathname = new URL(request.url).pathname
      const skip = pathname === "/log"
      if (!skip) log.info("request", { method: request.method, path: pathname })
      const timer = log.time("request", { method: request.method, path: pathname })
      try {
        const response =
          request.method === "OPTIONS"
            ? corsPreflight(request, opts)
            : (authorize(request) ??
              (isProductionHttpApiRequest(request) ? await dispatcher.handle(request, env) : await special.handleUI(request)))
        return await maybeCompress(request, applyCors(request, response, opts))
      } catch (error) {
        return applyCors(request, errorResponse(error), opts)
      } finally {
        if (!skip) timer.stop()
      }
    },
    request(input, init) {
      const request =
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init)
      return this.fetch(request)
    },
  }

  return {
    app,
    runtime,
    dispose: dispatcher.dispose,
  }
}

export async function openapi() {
  const { controlOpenApi } = await import("./control-openapi")
  return controlOpenApi()
}

export let url: URL

export async function listen(opts: {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  cors?: string[]
}): Promise<Listener> {
  const built = create(opts)
  const server = await built.runtime.listen(opts)
  const automationScheduler = AutomationScheduler.current()
  try {
    await automationScheduler.settleOwner()
  } catch (error) {
    AutomationScheduler.stopProcess({ stopRuns: false })
    try {
      await server.stop(true)
      await built.dispose()
    } catch (stopError) {
      log.error("server cleanup after scheduler settle failure failed", { error: stopError })
    }
    throw error
  }

  const next = new URL("http://localhost")
  next.hostname = opts.hostname
  next.port = String(server.port)
  url = next

  const mdns =
    opts.mdns &&
    server.port &&
    opts.hostname !== "127.0.0.1" &&
    opts.hostname !== "localhost" &&
    opts.hostname !== "::1"
  if (mdns) {
    MDNS.publish(server.port, opts.mdnsDomain)
  } else if (opts.mdns) {
    log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
  }

  let closing: Promise<void> | undefined
  return {
    hostname: opts.hostname,
    port: server.port,
    url: next,
    stop(close?: boolean) {
      closing ??= (async () => {
        if (mdns) MDNS.unpublish()
        AutomationScheduler.stopProcess({ stopRuns: false })
        await server.stop(close)
        await built.dispose()
      })()
      return closing
    },
  }
}

export * as Server from "./server"
