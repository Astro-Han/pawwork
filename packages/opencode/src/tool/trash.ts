import path from "path"
import trash from "trash"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "../filesystem"
import { Instance } from "../project/instance"
import DESCRIPTION from "./trash.txt"
import { assertExternalDirectoryEffect } from "./external-directory"

const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "The file or directory path to move to the system Trash" }),
})

export const TrashTool = Tool.define(
  "trash",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const target = path.isAbsolute(params.path) ? params.path : path.join(Instance.directory, params.path)
          const info = yield* fs.stat(target).pipe(
            Effect.catchIf(
              (e) => (e as any)?.cause?.code === "ENOENT" || (e as any)?.reason?._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
          )

          yield* assertExternalDirectoryEffect(ctx, target, {
            kind: info?.type === "Directory" ? "directory" : "file",
          })

          if (!info) {
            throw new Error(`Path not found: ${target}`)
          }

          const localTarget = path.relative(Instance.directory, target)
          const permissionPattern = Instance.containsPath(target) ? localTarget : target
          yield* ctx.ask({
            permission: "trash",
            patterns: [permissionPattern],
            always: ["*"],
            metadata: {
              filepath: target,
            },
          })

          yield* Effect.promise(() => trash([target], { glob: false }))

          return {
            title: Instance.containsPath(target) ? localTarget : target,
            metadata: {
              filepath: target,
            },
            output: "Moved item to Trash successfully.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
