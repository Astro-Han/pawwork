import type { MiddlewareHandler } from "hono"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { WorkspaceID } from "@/control-plane/schema"
import { Filesystem } from "@/util/filesystem"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"

export function InstanceMiddleware(workspaceID?: WorkspaceID): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
    const directory = Filesystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    const runInstance = () =>
      Instance.provide({
        directory,
        init: InstanceBootstrap,
        fn: () => next(),
      })

    if (!workspaceID) return runInstance()

    return WorkspaceContext.provide({
      workspaceID,
      fn: runInstance,
    })
  }
}
