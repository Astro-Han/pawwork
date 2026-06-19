import type { Hono } from "hono"
import { AsyncQueue } from "@/util/queue"
import { handleInstanceEventStream } from "./instance/event"
import {
  handleGlobalEventStream,
  handleGlobalSyncEventStream,
  type GlobalRoutesOptions,
} from "./instance/global"
import { handleUIRequest } from "./ui"
import { requestContextFromRequest, withRequestContext } from "./request-context"
import { SyncEvent } from "@/sync"

export type ProductionSpecialHandler = {
  handle(request: Request, env?: unknown): Promise<Response | undefined>
  handleInstance(request: Request, env?: unknown): Promise<Response | undefined>
  handleUI(request: Request): Promise<Response>
}

export function isGlobalSpecialRequest(method: string, pathname: string) {
  return method === "GET" && (pathname === "/global/event" || pathname === "/global/sync-event")
}

export function isWorkspaceWebSocketSpecialRequest(method: string, pathname: string) {
  return method === "GET" && pathname === "/__workspace_ws"
}

export function isInstanceSpecialRequest(method: string, pathname: string) {
  return method === "GET" && (pathname === "/event" || /^\/pty\/[^/]+\/connect$/.test(pathname))
}

export function createProductionSpecialHandler(input: {
  websocketCompatibilityApp: Hono
  globalRoutes?: GlobalRoutesOptions
}): ProductionSpecialHandler {
  const globalRoutes = input.globalRoutes ?? {}
  const replayBridge = globalRoutes.replayBridge
  const heartbeatMs = globalRoutes.heartbeatMs
  const syncSubscribe =
    globalRoutes.syncSubscribe ??
    ((q: AsyncQueue<string | null>) => {
      return SyncEvent.subscribeAll(({ def, event }) => {
        q.push(
          JSON.stringify({
            payload: {
              ...event,
              type: SyncEvent.versionedType(def.type, def.version),
            },
          }),
        )
      })
    })

  const handle = async (request: Request, env?: unknown) => {
    const pathname = new URL(request.url).pathname
    if (request.method === "GET" && pathname === "/global/event") {
      const snapshot = requestContextFromRequest(request, {})
      return withRequestContext(snapshot, () =>
        Promise.resolve(handleGlobalEventStream(request, replayBridge, heartbeatMs)),
      )
    }
    if (request.method === "GET" && pathname === "/global/sync-event") {
      const snapshot = requestContextFromRequest(request, {})
      return withRequestContext(snapshot, () =>
        Promise.resolve(handleGlobalSyncEventStream(request, syncSubscribe, heartbeatMs)),
      )
    }
    if (isWorkspaceWebSocketSpecialRequest(request.method, pathname)) {
      return Promise.resolve(input.websocketCompatibilityApp.fetch(request, (env ?? {}) as never))
    }
    return undefined
  }

  return {
    handle,
    async handleInstance(request, env) {
      const pathname = new URL(request.url).pathname
      if (request.method === "GET" && pathname === "/event") return handleInstanceEventStream(request)
      if (isInstanceSpecialRequest(request.method, pathname)) {
        return Promise.resolve(input.websocketCompatibilityApp.fetch(request, (env ?? {}) as never))
      }
      return undefined
    },
    handleUI: handleUIRequest,
  }
}
