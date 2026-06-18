import { deleteMemoryEntry, readMemory, resetMemory, setMemoryDisabled, updateRawMemory } from "@/server/instance/memory"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { MemoryApi } from "../groups/memory"

const MemoryRawInput = z.object({ content: z.string() })
const MemoryDisabledInput = z.object({ disabled: z.boolean() })

function isJsonContentType(contentType: string | undefined) {
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

function invalidMemoryFailure(error: unknown) {
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: "invalid_memory_file", reason: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    ),
  )
}

export const memoryHandlers = HttpApiBuilder.group(MemoryApi, "memory", (handlers) =>
  handlers
    .handleRaw("get", () => readMemory().pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))))
    .handleRaw("update", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, MemoryRawInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* updateRawMemory(payload.content).pipe(
          Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
          Effect.catch(invalidMemoryFailure),
          Effect.catchDefect(invalidMemoryFailure),
        )
      }),
    )
    .handleRaw("reset", () => resetMemory().pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))))
    .handleRaw("disabled", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, MemoryDisabledInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* setMemoryDisabled(payload.disabled).pipe(
          Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        )
      }),
    )
    .handleRaw("deleteEntry", (ctx) =>
      deleteMemoryEntry(ctx.params.id).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
    ),
)
