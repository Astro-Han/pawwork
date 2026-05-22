import { AsyncLocalStorage } from "node:async_hooks"
import type { Context } from "hono"
import { directoryKey, type LifecycleClientAction, type LifecycleRequest } from "@/session/lifecycle-provenance"

export type ClientActionSnapshot = LifecycleClientAction
export type RequestContextSnapshot = LifecycleRequest

const storage = new AsyncLocalStorage<RequestContextSnapshot>()

export function currentRequestContext(): RequestContextSnapshot | undefined {
  return storage.getStore()
}

export async function withRequestContext<T>(snapshot: RequestContextSnapshot, fn: () => Promise<T>): Promise<T> {
  return storage.run(snapshot, fn)
}

export function requestContextFromHono(
  c: Context,
  input: { directory?: string; workspaceID?: string },
): RequestContextSnapshot {
  const clientActionID = safeHeaderToken(c.req.header("x-pawwork-client-action-id"))
  const clientActionKind = safeHeaderToken(c.req.header("x-pawwork-client-action-kind"))
  const routeSessionID = safeHeaderToken(c.req.header("x-pawwork-route-session-id"))
  const visibleSessionID = safeHeaderToken(c.req.header("x-pawwork-visible-session-id"))
  const client_action = clientActionID
    ? {
        id: clientActionID,
        kind: clientActionKind ?? "unknown",
        route_session_id: routeSessionID,
        visible_session_id: visibleSessionID,
      }
    : undefined
  return {
    method: c.req.method,
    path: c.req.path,
    source: client_action ? "renderer" : "local_api",
    directory_key: input.directory ? directoryKey(input.directory) : undefined,
    workspace_id: input.workspaceID,
    client_action,
  }
}

function safeHeaderToken(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 100) return "unknown"
  if (/[/\\]|https?:\/\//i.test(trimmed)) return "unknown"
  if (/token|secret|bearer|sk-|cookie|password/i.test(trimmed)) return "unknown"
  if (!/^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return "unknown"
  return trimmed
}
