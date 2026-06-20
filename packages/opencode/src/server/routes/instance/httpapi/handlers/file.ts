import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { Instance } from "@/project/instance"
import { FileApi } from "../groups/file"

const findText = Effect.fn("FileHandlers.findText")(function* (pattern: string) {
  const rg = yield* Ripgrep.Service
  return yield* rg.search({
    cwd: Instance.directory,
    pattern,
    limit: 10,
  })
})

const findFiles = Effect.fn("FileHandlers.findFiles")(function* (input: {
  query: string
  dirs?: "true" | "false"
  type?: "file" | "directory"
  limit?: number
}) {
  const file = yield* File.Service
  return yield* file.search({
    query: input.query,
    limit: input.limit ?? 10,
    dirs: input.dirs !== "false",
    type: input.type,
  })
})

const listFiles = Effect.fn("FileHandlers.list")(function* (path: string) {
  const file = yield* File.Service
  return yield* file.list(path)
})

const readFileContent = Effect.fn("FileHandlers.read")(function* (path: string) {
  const file = yield* File.Service
  return yield* file.read(path)
})

const getFileStatus = Effect.fn("FileHandlers.status")(function* () {
  const file = yield* File.Service
  return yield* file.status()
})

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
