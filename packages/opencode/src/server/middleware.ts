import { Provider } from "../provider"
import { NamedError } from "@opencode-ai/util/error"
import { NotFoundError } from "../storage/db"
import { Session } from "../session"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ErrorHandler, MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "@opencode-ai/core/util/log"
import { cors } from "hono/cors"
import { compress } from "hono/compress"
import { ServerAuth } from "./auth"

const log = Log.create({ service: "server" })

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
  // Never serialize err.stack/message into the response: it leaks internal paths and
  // implementation detail to any client. The full error is already in the server log above.
  return c.json(new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(), {
    status: 500,
  })
}

export const AuthMiddleware: MiddlewareHandler = async (c, next) => {
  const response = ServerAuth.authorizeRequest(c.req.raw)
  if (response) return response
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
