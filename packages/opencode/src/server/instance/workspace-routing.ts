import { Effect } from "effect"
import { WorkspaceID } from "@/control-plane/schema"
import type { Target } from "@/control-plane/types"
import { Workspace } from "@/control-plane/workspace"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const LOCAL_ROUTE_RULES: Array<Rule> = [
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

export type WorkspaceRouteDecision =
  | { action: "provide-local-workspace" }
  | { action: "serve-local-cache" }
  | { action: "proxy-websocket" }
  | { action: "proxy-http" }
  | { action: "pass-missing-session-delete" }
  | { action: "missing-workspace-error" }

export type WorkspaceRouteResolution =
  | { action: "provide-local-context"; directory: string; workspaceID?: WorkspaceID; createLegacyConfig?: boolean }
  | { action: "serve-local-cache" }
  | { action: "proxy-websocket"; target: Extract<Target, { type: "remote" }> }
  | { action: "proxy-http"; target: Extract<Target, { type: "remote" }>; workspaceID: WorkspaceID }
  | { action: "pass-missing-session-delete" }
  | { action: "missing-workspace-error"; workspaceID: WorkspaceID }

export function isLocalCachedRoute(method: string, pathname: string) {
  for (const rule of LOCAL_ROUTE_RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? pathname === rule.path : pathname === rule.path || pathname.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

export function sessionIDForWorkspaceRouting(pathname: string) {
  if (pathname === "/session/status") return undefined
  if (pathname.startsWith("/session/__e2e/")) return undefined

  const id = pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
  if (!id) return undefined

  return SessionID.make(id)
}

export function shouldCreateLegacyConfigBeforeNoWorkspacePath(input: {
  pathname: string
  ensureConfig: boolean
  isPawWork: boolean
}) {
  return input.pathname === "/path" && input.ensureConfig && !input.isPawWork
}

async function getSessionWorkspace(pathname: string) {
  const id = sessionIDForWorkspaceRouting(pathname)
  if (!id) return null

  const session = await Session.get(id).catch(() => undefined)
  return session?.workspaceID
}

export function resolveWorkspaceRoute(input: {
  method: string
  pathname: string
  directory: string
  workspaceID?: string | null
  ensureConfig: boolean
  isPawWork: boolean
  isWebSocketUpgrade?: boolean
}): Effect.Effect<WorkspaceRouteResolution, unknown> {
  return Effect.promise(async () => {
    const sessionWorkspaceID = await getSessionWorkspace(input.pathname)
    const workspaceID = sessionWorkspaceID || input.workspaceID

    if (!workspaceID) {
      const createLegacyConfig = shouldCreateLegacyConfigBeforeNoWorkspacePath({
        pathname: input.pathname,
        ensureConfig: input.ensureConfig,
        isPawWork: input.isPawWork,
      })
      return {
        action: "provide-local-context",
        directory: input.directory,
        createLegacyConfig: createLegacyConfig || undefined,
      }
    }

    const id = WorkspaceID.make(workspaceID)
    const workspace = await Workspace.record(id)

    if (!workspace) {
      const decision = classifyWorkspaceRoute({
        method: input.method,
        pathname: input.pathname,
        target: "missing",
      })
      if (decision.action === "pass-missing-session-delete") {
        return { action: "pass-missing-session-delete" }
      }
      return { action: "missing-workspace-error", workspaceID: id }
    }

    Workspace.ensureSync(workspace, input.directory)

    const adaptor = await Workspace.resolveAdaptor({
      ...workspace,
      hint: input.directory,
    })
    const target = await adaptor.target(workspace)

    if (target.type === "local") {
      const decision = classifyWorkspaceRoute({
        method: input.method,
        pathname: input.pathname,
        target: target.type,
      })
      if (decision.action !== "provide-local-workspace") {
        throw new Error(`Unexpected local workspace routing decision: ${decision.action}`)
      }
      return {
        action: "provide-local-context",
        directory: target.directory,
        workspaceID: id,
      }
    }

    const decision = classifyWorkspaceRoute({
      method: input.method,
      pathname: input.pathname,
      target: target.type,
      isWebSocketUpgrade: input.isWebSocketUpgrade,
    })

    if (decision.action === "serve-local-cache") return { action: "serve-local-cache" }
    if (decision.action === "proxy-websocket") return { action: "proxy-websocket", target }
    return { action: "proxy-http", target, workspaceID: id }
  })
}

export function classifyWorkspaceRoute(input: {
  method: string
  pathname: string
  target: "missing" | "local" | "remote"
  isWebSocketUpgrade?: boolean
}): WorkspaceRouteDecision {
  if (input.target === "missing") {
    if (input.method === "DELETE" && /\/session\/[^/]+$/.test(input.pathname)) {
      return { action: "pass-missing-session-delete" }
    }
    return { action: "missing-workspace-error" }
  }

  if (input.target === "local") return { action: "provide-local-workspace" }
  if (isLocalCachedRoute(input.method, input.pathname)) return { action: "serve-local-cache" }
  if (input.isWebSocketUpgrade) return { action: "proxy-websocket" }
  return { action: "proxy-http" }
}
