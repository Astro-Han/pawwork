import type { MiddlewareHandler } from "hono"
import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { WorkspaceID } from "@/control-plane/schema"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"

export function InstanceMiddleware(workspaceID?: WorkspaceID): MiddlewareHandler {
  return async (c, next) => {
    const pawworkDefault = path.join(os.homedir(), "PawWork")
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || pawworkDefault
    const directory = Filesystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    if (!c.req.query("directory") && !c.req.header("x-opencode-directory")) {
      try {
        mkdirSync(pawworkDefault, { recursive: true })
      } catch {
        // Ignore: home may be unwritable or path may be a regular file
      }
    }

    const runInstance = () =>
      Instance.provide({
        directory,
        fn: () => next(),
      })

    if (!workspaceID) return runInstance()

    return WorkspaceContext.provide({
      workspaceID,
      fn: runInstance,
    })
  }
}
