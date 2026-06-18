import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { File } from "../../file"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { AppRuntime } from "../../effect/app-runtime"
import { lazy } from "../../util/lazy"

const runFileRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

const findText = Effect.fn("FileRoutes.findText")(function* (pattern: string) {
  const rg = yield* Ripgrep.Service
  return yield* rg.search({
    cwd: Instance.directory,
    pattern,
    limit: 10,
  })
})

const findFiles = Effect.fn("FileRoutes.findFiles")(function* (input: {
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

const listFiles = Effect.fn("FileRoutes.list")(function* (path: string) {
  const file = yield* File.Service
  return yield* file.list(path)
})

const readFileContent = Effect.fn("FileRoutes.read")(function* (path: string) {
  const file = yield* File.Service
  return yield* file.read(path)
})

const getFileStatus = Effect.fn("FileRoutes.status")(function* () {
  const file = yield* File.Service
  return yield* file.status()
})

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    items: z.array(Ripgrep.SearchMatch.zod),
                    partial: z.boolean(),
                    partialReason: z.enum(["invalid_pattern", "partial_io"]).optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await runFileRoute(findText(pattern))
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await runFileRoute(findFiles({ query, dirs, type, limit }))
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await runFileRoute(listFiles(path))
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await runFileRoute(readFileContent(path))
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await runFileRoute(getFileStatus())
        return c.json(content)
      },
    ),
)
