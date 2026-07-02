import { Workspace } from "@/control-plane/workspace"
import { WorkspaceID } from "@/control-plane/schema"
import { Instance } from "@/project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { WorkspaceApi } from "../groups/workspace"

const WorkspaceCreateBody = z.object({
  id: WorkspaceID.zod.optional(),
  type: z.string(),
  branch: z.string().nullable(),
  extra: z.unknown().nullable(),
})

type WorkspaceCreateBody = z.infer<typeof WorkspaceCreateBody>

function preserveWorkspaceRouteError<A>(effect: Effect.Effect<A, Workspace.WorkspaceError>) {
  return effect.pipe(
    Effect.catch((error) => {
      // Preserve facade-era errors so local HttpApi mirrors ErrorMiddleware's NamedError status mapping.
      if (error.cause instanceof Error) return Effect.fail(error.cause)
      return Effect.fail(error)
    }),
  )
}

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

function workspaceFailure(error: unknown) {
  if (error instanceof Workspace.WorkspaceError && error.cause instanceof Error) return workspaceFailure(error.cause)
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

export const workspaceHandlers = HttpApiBuilder.group(WorkspaceApi, "workspace", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service

    const create = Effect.fn("WorkspaceHttpApi.create")(function* (body: WorkspaceCreateBody) {
      return yield* preserveWorkspaceRouteError(
        workspace.create({
          projectID: Instance.project.id,
          ...body,
        }),
      )
    })

    const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
      return yield* preserveWorkspaceRouteError(workspace.list(Instance.project))
    })

    const status = Effect.fn("WorkspaceHttpApi.status")(function* () {
      const workspaces = yield* preserveWorkspaceRouteError(workspace.list(Instance.project))
      const ids = new Set(workspaces.map((item) => item.id))
      const statuses = yield* preserveWorkspaceRouteError(workspace.status())
      return statuses.filter((item) => ids.has(item.workspaceID))
    })

    const remove = Effect.fn("WorkspaceHttpApi.remove")(function* (id: WorkspaceID) {
      return yield* preserveWorkspaceRouteError(workspace.remove(id))
    })

    return handlers
      .handleRaw("create", (ctx) =>
        Effect.gen(function* () {
          const payload = yield* parseJsonBody(ctx.request, WorkspaceCreateBody)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          const result = yield* create(payload).pipe(
            Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
            Effect.catch(workspaceFailure),
            Effect.catchDefect(workspaceFailure),
          )
          return result
        }),
      )
      .handleRaw("list", () =>
        list().pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch(workspaceFailure),
          Effect.catchDefect(workspaceFailure),
        ),
      )
      .handleRaw("status", () =>
        status().pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch(workspaceFailure),
          Effect.catchDefect(workspaceFailure),
        ),
      )
      .handleRaw("remove", (ctx) =>
        remove(ctx.params.id).pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch(workspaceFailure),
          Effect.catchDefect(workspaceFailure),
        ),
      )
  }),
)
