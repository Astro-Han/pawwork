import { findFiles, findText, getFileStatus, listFiles, readFileContent } from "@/server/instance/file"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { FileApi } from "../groups/file"

export const fileHandlers = HttpApiBuilder.group(FileApi, "file", (handlers) =>
  handlers
    .handleRaw("findText", (ctx) =>
      findText(ctx.query.pattern).pipe(Effect.orDie, Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("findFile", (ctx) =>
      findFiles({
        query: ctx.query.query,
        dirs: ctx.query.dirs,
        type: ctx.query.type,
        limit: ctx.query.limit,
      }).pipe(Effect.orDie, Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("findSymbol", () => Effect.succeed(HttpServerResponse.jsonUnsafe([])))
    .handleRaw("list", (ctx) =>
      listFiles(ctx.query.path).pipe(Effect.orDie, Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("content", (ctx) =>
      readFileContent(ctx.query.path).pipe(Effect.orDie, Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    )
    .handleRaw("status", () =>
      getFileStatus().pipe(Effect.orDie, Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    ),
)
