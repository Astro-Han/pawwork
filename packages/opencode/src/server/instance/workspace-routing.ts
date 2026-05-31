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

export function shouldCreateLegacyConfigBeforePath(input: {
  pathname: string
  ensureConfig: boolean
  hasWorkspace: boolean
  isPawWork: boolean
}) {
  return input.pathname === "/path" && input.ensureConfig && !input.hasWorkspace && !input.isPawWork
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
