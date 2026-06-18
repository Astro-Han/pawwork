import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { SessionLiveness } from "@/session/liveness"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { PermissionApi } from "../groups/permission"

type PermissionReplyBody = {
  reply: z.infer<typeof Permission.Reply>
  message?: string
}

const PermissionReplyBody = z.object({
  reply: Permission.Reply,
  message: z.string().optional(),
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

function permissionFailure(error: unknown) {
  if (error instanceof NotFoundError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 404 }))
  if (error instanceof NamedError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 500 }))
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

export const permissionHandlers = HttpApiBuilder.group(PermissionApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* permission.list().pipe(
        Effect.flatMap((items) =>
          SessionLiveness.pruneDangling(items, (sessionID) => permission.clearSession(sessionID, "dangling_session")),
        ),
      )
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (requestID: PermissionID, json: PermissionReplyBody) {
      yield* permission.reply({
        requestID,
        reply: json.reply,
        message: json.message,
      })
      return true
    })

    return handlers
      .handleRaw("list", () =>
        list().pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch(permissionFailure),
          Effect.catchDefect(permissionFailure),
        ),
      )
      .handleRaw("reply", (ctx) =>
        Effect.gen(function* () {
          const payload = yield* parseJsonBody(ctx.request, PermissionReplyBody)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          const result = yield* reply(ctx.params.requestID, payload).pipe(
            Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
            Effect.catch(permissionFailure),
            Effect.catchDefect(permissionFailure),
          )
          return result
        }),
      )
  }),
)
