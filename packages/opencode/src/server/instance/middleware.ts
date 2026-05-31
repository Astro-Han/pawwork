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
import { Session } from "@/session"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Global } from "@/global"
import { Runtime } from "@opencode-ai/core/runtime"
import { requestContextFromHono, withRequestContext } from "@/server/request-context"
import {
  classifyWorkspaceRoute,
  sessionIDForWorkspaceRouting,
  shouldCreateLegacyConfigBeforePath,
} from "./workspace-routing"

async function getSessionWorkspace(url: URL) {
  const id = sessionIDForWorkspaceRouting(url.pathname)
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
    const sessionWorkspaceID = await getSessionWorkspace(url)
    const workspaceID = sessionWorkspaceID || url.searchParams.get("workspace")

    // If no workspace is provided we use the project
    if (!workspaceID) {
      if (
        shouldCreateLegacyConfigBeforePath({
          pathname: url.pathname,
          ensureConfig: url.searchParams.get("ensureConfig") === "true",
          hasWorkspace: false,
          isPawWork: Runtime.isPawWork(),
        })
      ) {
        try {
          mkdirSync(Global.Path.config, { recursive: true })
        } catch {
          // Ignore: handler will propagate the config path creation error.
        }
      }

      const snapshot = requestContextFromHono(c, { directory })
      return withRequestContext(snapshot, () =>
        Instance.provide({
          directory,
          async fn() {
            return next()
          },
        }),
      )
    }

    const workspace = await Workspace.record(WorkspaceID.make(workspaceID))

    if (!workspace) {
      const decision = classifyWorkspaceRoute({
        method: c.req.method,
        pathname: url.pathname,
        target: "missing",
      })
      // Special-case deleting a session in case user's data in a
      // weird state. Allow them to forcefully delete a synced session
      // even if the remote workspace is not in their data.
      //
      // The lets the `DELETE /session/:id` endpoint through and we've
      // made sure that it will run without an instance
      if (decision.action === "pass-missing-session-delete") {
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
      const decision = classifyWorkspaceRoute({
        method: c.req.method,
        pathname: url.pathname,
        target: target.type,
      })
      if (decision.action !== "provide-local-workspace") {
        throw new Error(`Unexpected local workspace routing decision: ${decision.action}`)
      }
      const snapshot = requestContextFromHono(c, { directory: target.directory, workspaceID })
      return WorkspaceContext.provide({
        workspaceID: WorkspaceID.make(workspaceID),
        fn: () =>
          withRequestContext(snapshot, () =>
            Instance.provide({
              directory: target.directory,
              async fn() {
                return next()
              },
            }),
          ),
      })
    }

    const decision = classifyWorkspaceRoute({
      method: c.req.method,
      pathname: url.pathname,
      target: target.type,
      isWebSocketUpgrade: c.req.header("upgrade")?.toLowerCase() === "websocket",
    })

    if (decision.action === "serve-local-cache") {
      // No instance provided because we are serving cached data; there
      // is no instance to work with
      return next()
    }

    if (decision.action === "proxy-websocket") {
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
