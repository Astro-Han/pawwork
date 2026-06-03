import { Provider } from "../provider"
import { NamedError } from "@opencode-ai/util/error"
import { NotFoundError } from "../storage/db"
import { Session } from "../session"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ErrorHandler, MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "@opencode-ai/core/util/log"
import { Flag } from "@opencode-ai/core/flag/flag"
import { cors } from "hono/cors"
import { compress } from "hono/compress"
import { Option, Redacted } from "effect"
import { ServerAuth } from "./auth"

const log = Log.create({ service: "server" })
const PTY_CONNECT_PATH = /^\/pty\/[^/]+\/connect$/

// Provider-auth failures the routes already declare as 400 (errors(400)) but that
// otherwise fall through to a 500 because their NamedError names are not NotFoundError.
const PROVIDER_AUTH_BAD_REQUEST = new Set([
  "ProviderAuthValidationFailed",
  "ProviderAuthOauthMissing",
  "ProviderAuthOauthCodeMissing",
  "ProviderAuthOauthCallbackFailed",
])

export const ErrorMiddleware: ErrorHandler = (err, c) => {
  if (err instanceof NamedError) {
    let status: ContentfulStatusCode
    if (err instanceof NotFoundError) status = 404
    else if (err instanceof Provider.ModelNotFoundError) status = 400
    else if (PROVIDER_AUTH_BAD_REQUEST.has(err.name)) status = 400
    else if (err.name.startsWith("Worktree")) status = 400
    else status = 500
    if (!(err instanceof NotFoundError)) {
      log.error("failed", {
        error: err,
      })
    }
    return c.json(err.toObject(), { status })
  }
  log.error("failed", {
    error: err,
  })
  if (err instanceof Session.BusyError) {
    // A busy session is a conflict (the run is still in progress), not a bad
    // request — surface it as 409 so callers can distinguish retry-later from
    // a malformed request (which the validators already return as 400).
    return c.json(new NamedError.Unknown({ message: err.message }).toObject(), { status: 409 })
  }
  if (err instanceof HTTPException) return err.getResponse()
  const message = err instanceof Error && err.stack ? err.stack : err.toString()
  return c.json(new NamedError.Unknown({ message }).toObject(), {
    status: 500,
  })
}

export const AuthMiddleware: MiddlewareHandler = async (c, next) => {
  const unauthorized = () => {
    c.header("WWW-Authenticate", 'Basic realm="opencode"')
    return c.text("Unauthorized", 401)
  }

  // Allow CORS preflight requests to succeed without auth.
  // Browser clients sending Authorization headers will preflight with OPTIONS.
  if (c.req.method === "OPTIONS") return next()

  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return next()

  if (c.req.method === "GET" && PTY_CONNECT_PATH.test(c.req.path) && c.req.query("ticket")) return next()

  const queryToken = c.req.query("auth_token")
  const authHeader = c.req.header("authorization")
  const header = queryToken ? "Basic " + queryToken : authHeader

  const match = header?.match(/^Basic\s+(.+)$/i)
  if (!match) return unauthorized()

  const credentialsPart = match[1]
  const decoded = Buffer.from(credentialsPart, "base64").toString("utf8")
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
  return next()
}

export const LoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const skip = c.req.path === "/log"
  if (!skip) {
    log.info("request", {
      method: c.req.method,
      path: c.req.path,
    })
  }
  const timer = log.time("request", {
    method: c.req.method,
    path: c.req.path,
  })
  await next()
  if (!skip) timer.stop()
}

export function CorsMiddleware(opts?: { cors?: string[] }): MiddlewareHandler {
  return cors({
    maxAge: 86_400,
    origin(input) {
      if (!input) return

      if (input.startsWith("http://localhost:")) return input
      if (input.startsWith("http://127.0.0.1:")) return input

      if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
      if (opts?.cors?.includes(input)) return input
    },
  })
}

const zipped = compress()
export const CompressionMiddleware: MiddlewareHandler = (c, next) => {
  const path = c.req.path
  const method = c.req.method
  if (path === "/event" || path === "/global/event") return next()
  if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return next()
  return zipped(c, next)
}
