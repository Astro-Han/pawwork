import type { MiddlewareHandler } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import { WorkspaceID } from "@/control-plane/schema"
import { ServerProxy } from "../proxy"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Global } from "@/global"
import { Runtime } from "@opencode-ai/core/runtime"
import { requestContextFromHono, withRequestContext, type RequestContextSnapshot } from "@/server/request-context"
import { resolveWorkspaceRoute } from "./workspace-routing"
import { AppRuntime } from "@/effect/app-runtime"

function provideLocalWorkspaceContext<R>(input: {
  directory: string
  workspaceID?: WorkspaceID
  request: RequestContextSnapshot
  fn: () => R
}) {
  const run = () =>
    withRequestContext(input.request, () =>
      Instance.provide({
        directory: input.directory,
        fn: input.fn,
      }),
    )

  if (!input.workspaceID) return run()
  return WorkspaceContext.provide({
    workspaceID: input.workspaceID,
    fn: run,
  })
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
    const decision = await AppRuntime.runPromise(
      resolveWorkspaceRoute({
        method: c.req.method,
        pathname: url.pathname,
        directory,
        workspaceID: url.searchParams.get("workspace"),
        ensureConfig: url.searchParams.get("ensureConfig") === "true",
        isPawWork: Runtime.isPawWork(),
        isWebSocketUpgrade: c.req.header("upgrade")?.toLowerCase() === "websocket",
      }),
    )

    if (decision.action === "provide-local-context") {
      if (decision.createLegacyConfig) {
        try {
          mkdirSync(Global.Path.config, { recursive: true })
        } catch {
          // Ignore: handler will propagate the config path creation error.
        }
      }

      return provideLocalWorkspaceContext({
        directory: decision.directory,
        workspaceID: decision.workspaceID,
        request: requestContextFromHono(c, { directory: decision.directory, workspaceID: decision.workspaceID }),
        fn: next,
      })
    }

    if (decision.action === "pass-missing-session-delete") {
      // Special-case deleting a session in case user's data in a
      // weird state. Allow them to forcefully delete a synced session
      // even if the remote workspace is not in their data.
      //
      // The lets the `DELETE /session/:id` endpoint through and we've
      // made sure that it will run without an instance
      return next()
    }

    if (decision.action === "missing-workspace-error") {
      return new Response(`Workspace not found: ${decision.workspaceID}`, {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })
    }

    if (decision.action === "serve-local-cache") {
      // No instance provided because we are serving cached data; there
      // is no instance to work with
      return next()
    }

    if (decision.action === "proxy-websocket") {
      return ServerProxy.websocket(upgrade, decision.target, c.req.raw, c.env)
    }

    const headers = new Headers(c.req.raw.headers)
    headers.delete("x-opencode-workspace")

    return ServerProxy.http(
      decision.target.url,
      decision.target.headers,
      new Request(c.req.raw, {
        headers,
      }),
      decision.workspaceID,
    )
  }
}
