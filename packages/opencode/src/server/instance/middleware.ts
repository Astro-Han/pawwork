import type { MiddlewareHandler } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import { WorkspaceID } from "@/control-plane/schema"
import { Workspace } from "@/control-plane/workspace"
import { ServerProxy } from "../proxy"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Global } from "@/global"
import { Runtime } from "@opencode-ai/core/runtime"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

function local(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

function getSessionID(url: URL) {
  if (url.pathname === "/session/status") return null

  const id = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
  if (!id) return null

  return SessionID.make(id)
}

async function getSessionWorkspace(url: URL) {
  const id = getSessionID(url)
  if (!id) return null

  const session = await Session.get(id).catch(() => undefined)
  return session?.workspaceID
}

export function WorkspaceRouterMiddleware(upgrade: UpgradeWebSocket): MiddlewareHandler {
  return async (c, next) => {
    const pawworkDefault = path.join(os.homedir(), "PawWork")
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || pawworkDefault
    const decoded = (() => {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    })()

    if (!c.req.query("directory") && !c.req.header("x-opencode-directory")) {
      try {
        mkdirSync(pawworkDefault, { recursive: true })
      } catch {
        // Ignore: home may be unwritable or path may be a regular file
      }
    }

    const directory = Filesystem.resolve(decoded)

    const url = new URL(c.req.url)
    if (url.pathname === "/path" && url.searchParams.get("ensureConfig") === "true" && !Runtime.isPawWork()) {
      mkdirSync(Global.Path.config, { recursive: true })
    }

    const sessionWorkspaceID = await getSessionWorkspace(url)
    const workspaceID = sessionWorkspaceID || url.searchParams.get("workspace")

    // If no workspace is provided we use the project
    if (!workspaceID) {
      return Instance.provide({
        directory,
        init: InstanceBootstrap,
        async fn() {
          return next()
        },
      })
    }

    const workspace = await Workspace.record(WorkspaceID.make(workspaceID))

    if (!workspace) {
      // Special-case deleting a session in case user's data in a
      // weird state. Allow them to forcefully delete a synced session
      // even if the remote workspace is not in their data.
      //
      // The lets the `DELETE /session/:id` endpoint through and we've
      // made sure that it will run without an instance
      if (url.pathname.match(/\/session\/[^/]+$/) && c.req.method === "DELETE") {
        return next()
      }

      return new Response(`Workspace not found: ${workspaceID}`, {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })
    }

    Workspace.ensureSync(workspace, directory)

    const adaptor = await Workspace.resolveAdaptor({
      ...workspace,
      hint: directory,
    })
    const target = await adaptor.target(workspace)

    if (target.type === "local") {
      return WorkspaceContext.provide({
        workspaceID: WorkspaceID.make(workspaceID),
        fn: () =>
          Instance.provide({
            directory: target.directory,
            init: InstanceBootstrap,
            async fn() {
              return next()
            },
          }),
      })
    }

    if (local(c.req.method, url.pathname)) {
      // No instance provided because we are serving cached data; there
      // is no instance to work with
      return next()
    }

    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return ServerProxy.websocket(upgrade, target, c.req.raw, c.env)
    }

    const headers = new Headers(c.req.raw.headers)
    headers.delete("x-opencode-workspace")

    return ServerProxy.http(
      target.url,
      target.headers,
      new Request(c.req.raw, {
        headers,
      }),
      WorkspaceID.make(workspaceID),
    )
  }
}
