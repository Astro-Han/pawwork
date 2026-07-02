import { Provider } from "@/provider"
import { Session } from "@/session"
import { NotFoundError } from "@/storage/db"
import { Log } from "@/util"
import { NamedError } from "@opencode-ai/util/error"
import { HTTPException } from "hono/http-exception"
import type { UpgradeWebSocket } from "./adapter"
import { ServerAuth } from "./auth"
import { createPtyConnectEvents } from "./instance/pty"
import { createWorkspaceWebSocketEvents } from "./proxy"

const log = Log.create({ service: "server-websocket" })
const PTY_CONNECT_PATH = /^\/pty\/([^/]+)\/connect$/
const PROVIDER_AUTH_BAD_REQUEST = new Set([
  "ProviderAuthValidationFailed",
  "ProviderAuthOauthMissing",
  "ProviderAuthOauthCodeMissing",
  "ProviderAuthOauthCallbackFailed",
])

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

export async function handleWebSocketCompatibilityRequest(
  request: Request,
  env: unknown,
  upgradeWebSocket: UpgradeWebSocket,
) {
  const auth = ServerAuth.authorizeRequest(request)
  if (auth) return auth

  try {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/__workspace_ws") {
      return upgradeWebSocket(request, env, createWorkspaceWebSocketEvents(request))
    }

    const pty = request.method === "GET" ? url.pathname.match(PTY_CONNECT_PATH) : undefined
    if (pty) {
      const events = await createPtyConnectEvents(request, pty[1]!)
      if (events instanceof Response) return events
      return upgradeWebSocket(request, env, events)
    }

    return undefined
  } catch (error) {
    return errorResponse(error)
  }
}
