import { Automation, ConflictError, ValidationError } from "@/automation"
import {
  AutomationIDParam,
  AutomationRunsQuery,
  conflictError,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  updateAutomation,
  validationDetailsFromIssues,
  validationError,
} from "@/server/instance/automation-actions"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { AutomationApi } from "../groups/automation"

type AutomationHttpResponse = HttpServerResponse.HttpServerResponse
type AutomationRouteParams = z.infer<typeof AutomationIDParam>
type AutomationRunsQueryInput = z.infer<typeof AutomationRunsQuery>

function isJsonContentType(contentType: string | undefined) {
  // Mirrors hono/validator's jsonRegex, reached through hono-openapi's validator("json").
  return /^application\/([a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=([^;]+))*$/.test(contentType ?? "")
}

function badRequestJson(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status: 400 })
}

function invalidAutomationJson(details: Automation.ValidationErrorDetail[]): AutomationHttpResponse {
  return HttpServerResponse.jsonUnsafe(
    Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details }),
    { status: 422 },
  )
}

function parseJsonBody<T>(
  request: HttpServerRequest.HttpServerRequest,
  schema: z.ZodType<T>,
): Effect.Effect<T | AutomationHttpResponse> {
  return Effect.gen(function* () {
    const body = isJsonContentType(request.headers["content-type"])
      ? yield* request.json.pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.raw("Malformed JSON in request body", { status: 400 }))),
        )
      : {}
    if (HttpServerResponse.isHttpServerResponse(body)) return body

    const parsed = schema.safeParse(body)
    if (!parsed.success) return invalidAutomationJson(validationDetailsFromIssues(parsed.error.issues, body))
    return parsed.data
  })
}

function parseRouteParams(raw: unknown): AutomationRouteParams | AutomationHttpResponse {
  const parsed = AutomationIDParam.safeParse(raw)
  if (!parsed.success) return badRequestJson({ data: raw, error: parsed.error.issues, success: false })
  return parsed.data
}

function parseRunsQuery(raw: unknown): AutomationRunsQueryInput | AutomationHttpResponse {
  const parsed = AutomationRunsQuery.safeParse(raw)
  if (!parsed.success) return badRequestJson({ data: raw, error: parsed.error.issues, success: false })
  return parsed.data
}

function unknownError(message = "Unexpected server error. Check server logs for details.") {
  return new NamedError.Unknown({ message }).toObject()
}

function automationFailure(error: unknown): Effect.Effect<AutomationHttpResponse> {
  if (error instanceof ValidationError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(validationError(error), { status: 422 }))
  }
  if (error instanceof ConflictError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(conflictError(error), { status: 409 }))
  }
  if (error instanceof NotFoundError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 404 }))
  }
  if (error instanceof NamedError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 500 }))
  }
  return Effect.succeed(HttpServerResponse.jsonUnsafe(unknownError(), { status: 500 }))
}

function jsonResponse<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<AutomationHttpResponse, never, R> {
  return effect.pipe(
    Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
    Effect.catch(automationFailure),
    Effect.catchDefect(automationFailure),
  )
}

function withParams<R>(
  raw: unknown,
  fn: (params: AutomationRouteParams) => Effect.Effect<AutomationHttpResponse, never, R>,
): Effect.Effect<AutomationHttpResponse, never, R> {
  return Effect.gen(function* () {
    const params = parseRouteParams(raw)
    if (HttpServerResponse.isHttpServerResponse(params)) return params
    return yield* fn(params)
  })
}

export const automationHandlers = HttpApiBuilder.group(AutomationApi, "automation", (handlers) =>
  handlers
    .handleRaw("list", () => jsonResponse(listAutomations()))
    .handleRaw("create", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, Automation.CreateInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        return yield* jsonResponse(createAutomation(payload))
      }),
    )
    .handleRaw("get", (ctx) => withParams(ctx.params, (params) => jsonResponse(getAutomation(params.automationID))))
    .handleRaw("update", (ctx) =>
      withParams(ctx.params, (params) =>
        Effect.gen(function* () {
          const payload = yield* parseJsonBody(ctx.request, Automation.UpdateInput)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          return yield* jsonResponse(updateAutomation(params.automationID, payload))
        }),
      ),
    )
    .handleRaw("delete", (ctx) => withParams(ctx.params, (params) => jsonResponse(deleteAutomation(params.automationID))))
    .handleRaw("runs", (ctx) =>
      withParams(ctx.params, (params) =>
        Effect.gen(function* () {
          const query = parseRunsQuery(ctx.query)
          if (HttpServerResponse.isHttpServerResponse(query)) return query
          return yield* jsonResponse(listAutomationRuns(params.automationID, query))
        }),
      ),
    )
    .handleRaw("runNow", (ctx) => withParams(ctx.params, (params) => jsonResponse(runAutomationNow(params.automationID))))
    .handleRaw("pause", (ctx) => withParams(ctx.params, (params) => jsonResponse(pauseAutomation(params.automationID))))
    .handleRaw("resume", (ctx) => withParams(ctx.params, (params) => jsonResponse(resumeAutomation(params.automationID)))),
)
