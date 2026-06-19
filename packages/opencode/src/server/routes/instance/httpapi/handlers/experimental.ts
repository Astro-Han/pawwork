import {
  createWorktree,
  getConsoleState,
  listConsoleOrgs,
  listExperimentalSessions,
  listResources,
  listToolIDs,
  listTools,
  listWorktrees,
  removeWorktree,
  resetWorktree,
  switchConsoleOrg,
} from "@/server/instance/experimental"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { ExperimentalApi } from "../groups/experimental"

const ConsoleSwitchBody = z.object({
  accountID: z.string(),
  orgID: z.string(),
})

const WorktreeCreateBody = z
  .object({
    name: z.string().optional(),
    startCommand: z.string().optional(),
  })
  .optional()
const WorktreeDirectoryBody = z.object({
  directory: z.string(),
})

function isJsonContentType(contentType: string | undefined) {
  // Mirrors hono/validator's jsonRegex, reached through hono-openapi's validator("json").
  return /^application\/([a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=([^;]+))*$/.test(contentType ?? "")
}

function badRequestJson(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status: 400 })
}

function parseJsonBody<T>(request: HttpServerRequest.HttpServerRequest, schema: z.ZodType<T>) {
  return Effect.gen(function* () {
    const body = isJsonContentType(request.headers["content-type"])
      ? yield* request.json.pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.raw("Malformed JSON in request body", { status: 400 }))),
        )
      : {}
    if (HttpServerResponse.isHttpServerResponse(body)) return body

    const parsed = schema.safeParse(body)
    if (!parsed.success) return badRequestJson({ data: body, error: parsed.error.issues, success: false })
    return parsed.data
  })
}

function experimentalFailure(error: unknown) {
  if (error instanceof NamedError) {
    const status = error.name.startsWith("Worktree") ? 400 : 500
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status }))
  }
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

function jsonResponse<A>(effect: Effect.Effect<A, unknown, unknown>) {
  return effect.pipe(
    Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
    Effect.catch(experimentalFailure),
    Effect.catchDefect(experimentalFailure),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(ExperimentalApi, "experimental", (handlers) =>
  handlers
    .handleRaw("capabilities", () => jsonResponse(Effect.succeed({ backgroundSubagents: false })))
    .handleRaw("console", () => jsonResponse(getConsoleState()))
    .handleRaw("consoleOrgs", () => jsonResponse(listConsoleOrgs()))
    .handleRaw("consoleSwitch", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, ConsoleSwitchBody)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* jsonResponse(switchConsoleOrg(payload))
      }),
    )
    .handleRaw("tool", (ctx) =>
      jsonResponse(
        listTools({
          provider: ctx.query.provider,
          model: ctx.query.model,
        }),
      ),
    )
    .handleRaw("toolIds", () => jsonResponse(listToolIDs()))
    .handleRaw("resource", () => jsonResponse(listResources()))
    .handleRaw("session", (ctx) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          listExperimentalSessions({
            directory: ctx.query.directory,
            roots: ctx.query.roots === undefined ? undefined : ctx.query.roots === "true",
            start: ctx.query.start,
            cursor: ctx.query.cursor === "" ? undefined : ctx.query.cursor,
            search: ctx.query.search,
            limit: ctx.query.limit,
            archived: ctx.query.archived === undefined ? undefined : ctx.query.archived === "true",
            sort: ctx.query.sort,
          }),
        )
        const headers =
          result.hasMore && result.sessions.length > 0
            ? {
                "Access-Control-Expose-Headers": "X-Next-Cursor",
                ...(result.nextCursor === undefined ? {} : { "x-next-cursor": result.nextCursor }),
              }
            : undefined
        return HttpServerResponse.jsonUnsafe(result.sessions, { headers })
      }).pipe(
        Effect.catch(experimentalFailure),
        Effect.catchDefect(experimentalFailure),
      ),
    )
    .handleRaw("worktreeCreate", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, WorktreeCreateBody)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* jsonResponse(createWorktree(payload))
      }),
    )
    .handleRaw("worktreeList", () => jsonResponse(listWorktrees()))
    .handleRaw("worktreeRemove", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, WorktreeDirectoryBody)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* jsonResponse(removeWorktree(payload))
      }),
    )
    .handleRaw("worktreeReset", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, WorktreeDirectoryBody)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* jsonResponse(resetWorktree(payload))
      }),
    ),
)
