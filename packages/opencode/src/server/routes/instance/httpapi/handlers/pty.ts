import { Pty } from "@/pty"
import { PtyID } from "@/pty/schema"
import { PtyTicket } from "@/pty/ticket"
import { Shell } from "@/shell/shell"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { PtyApi } from "../groups/pty"

const PtyParam = z.object({ ptyID: PtyID.zod })

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

function parseZod<T>(data: unknown, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(data)
  if (!parsed.success) return badRequestJson({ data, error: parsed.error.issues, success: false })
  return parsed.data
}

function notFound(message: string) {
  return new NotFoundError({ message })
}

function ptyFailure(error: unknown) {
  if (error instanceof NotFoundError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 404 }))
  if (error instanceof NamedError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 500 }))
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

export const ptyHandlers = HttpApiBuilder.group(PtyApi, "pty", (handlers) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service

    const list = Effect.fn("PtyHttpApi.list")(function* () {
      return yield* pty.list()
    })

    const create = Effect.fn("PtyHttpApi.create")(function* (input: Pty.CreateInput) {
      return yield* pty.create(input)
    })

    const get = Effect.fn("PtyHttpApi.get")(function* (id: PtyID) {
      const info = yield* pty.get(id)
      if (!info) return yield* Effect.fail(notFound("Session not found"))
      return info
    })

    const update = Effect.fn("PtyHttpApi.update")(function* (id: PtyID, input: Pty.UpdateInput) {
      const info = yield* pty.update(id, input)
      if (!info) return yield* Effect.fail(notFound("Session not found"))
      return info
    })

    const remove = Effect.fn("PtyHttpApi.remove")(function* (id: PtyID) {
      const info = yield* pty.get(id)
      if (!info) return yield* Effect.fail(notFound("Session not found"))
      yield* pty.remove(id)
      return true
    })

    const connectToken = Effect.fn("PtyHttpApi.connectToken")(function* (id: PtyID) {
      const info = yield* pty.get(id)
      if (!info) return yield* Effect.fail(notFound("PTY session not found"))
      return PtyTicket.issue({ ptyID: id })
    })

    const shells = Effect.fn("PtyHttpApi.shells")(function* () {
      return yield* Effect.promise(() => Shell.list())
    })

    return handlers
      .handleRaw("shells", () =>
        shells().pipe(
          Effect.map((items) => HttpServerResponse.jsonUnsafe(items)),
          Effect.catch(ptyFailure),
          Effect.catchDefect(ptyFailure),
        ),
      )
      .handleRaw("list", () =>
        list().pipe(
          Effect.map((sessions) => HttpServerResponse.jsonUnsafe(sessions)),
          Effect.catch(ptyFailure),
          Effect.catchDefect(ptyFailure),
        ),
      )
      .handleRaw("create", (ctx) =>
        Effect.gen(function* () {
          const payload = yield* parseJsonBody(ctx.request, Pty.CreateInput)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          return yield* create(payload).pipe(
            Effect.map((info) => HttpServerResponse.jsonUnsafe(info)),
            Effect.catch(ptyFailure),
            Effect.catchDefect(ptyFailure),
          )
        }),
      )
      .handleRaw("get", (ctx) =>
        Effect.gen(function* () {
          const params = parseZod(ctx.params, PtyParam)
          if (HttpServerResponse.isHttpServerResponse(params)) return params
          return yield* get(params.ptyID).pipe(
            Effect.map((info) => HttpServerResponse.jsonUnsafe(info)),
            Effect.catch(ptyFailure),
            Effect.catchDefect(ptyFailure),
          )
        }),
      )
      .handleRaw("update", (ctx) =>
        Effect.gen(function* () {
          const params = parseZod(ctx.params, PtyParam)
          if (HttpServerResponse.isHttpServerResponse(params)) return params
          const payload = yield* parseJsonBody(ctx.request, Pty.UpdateInput)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          return yield* update(params.ptyID, payload).pipe(
            Effect.map((info) => HttpServerResponse.jsonUnsafe(info)),
            Effect.catch(ptyFailure),
            Effect.catchDefect(ptyFailure),
          )
        }),
      )
      .handleRaw("remove", (ctx) =>
        Effect.gen(function* () {
          const params = parseZod(ctx.params, PtyParam)
          if (HttpServerResponse.isHttpServerResponse(params)) return params
          return yield* remove(params.ptyID).pipe(
            Effect.map((removed) => HttpServerResponse.jsonUnsafe(removed)),
            Effect.catch(ptyFailure),
            Effect.catchDefect(ptyFailure),
          )
        }),
      )
      .handleRaw("connectToken", (ctx) =>
        Effect.gen(function* () {
          const params = parseZod(ctx.params, PtyParam)
          if (HttpServerResponse.isHttpServerResponse(params)) return params
          return yield* connectToken(params.ptyID).pipe(
            Effect.map((token) => HttpServerResponse.jsonUnsafe(token)),
            Effect.catch(ptyFailure),
            Effect.catchDefect(ptyFailure),
          )
        }),
      )
  }),
)
