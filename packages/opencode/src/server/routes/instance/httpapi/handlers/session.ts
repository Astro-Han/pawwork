import { Bus } from "@/bus"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionRouteEffects } from "@/server/instance/session"
import { Session as SessionNs } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { MessageID, SessionID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { NotFoundError } from "@/storage/db"
import { ExternalResult } from "@/tool/external-result"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { SessionApi } from "../groups/session"

const log = Log.create({ service: "server" })

const SessionUpdateBody = z.object({
  title: z.string().optional(),
  permission: Permission.Ruleset.optional(),
  time: z
    .object({
      archived: z.number().optional(),
    })
    .optional(),
})

const InitBody = z.object({
  modelID: ModelID.zod,
  providerID: ProviderID.zod,
  messageID: MessageID.zod,
})

const E2EUpdateTodosBody = z.object({
  sessionID: SessionID.zod,
  todos: z.array(Todo.Input),
})

const ToolRespondBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("submit"),
    messageID: MessageID.zod,
    callID: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal("dismiss"),
    messageID: MessageID.zod,
    callID: z.string(),
  }),
])

const SummarizeBody = z.object({
  providerID: ProviderID.zod,
  modelID: ModelID.zod,
  auto: z.boolean().optional().default(false),
})

const PermissionBody = z.object({ response: Permission.Reply })
const OptionalForceBody = z.object({ force: z.boolean().optional() }).optional()

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

function unknownError(message = "Unexpected server error. Check server logs for details.") {
  return new NamedError.Unknown({ message }).toObject()
}

function sessionFailure(error: unknown) {
  if (error instanceof NotFoundError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 404 }))
  if (error instanceof Provider.ModelNotFoundError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
  }
  if (error instanceof SessionNs.BusyError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(unknownError(error.message), { status: 409 }))
  }
  if (error instanceof NamedError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 500 }))
  return Effect.succeed(HttpServerResponse.jsonUnsafe(unknownError(), { status: 500 }))
}

function jsonResponse<A>(effect: Effect.Effect<A, unknown, unknown>) {
  return effect.pipe(
    Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
    Effect.catch(sessionFailure),
    Effect.catchDefect(sessionFailure),
  )
}

function okAfter(effect: Effect.Effect<unknown, unknown, unknown>) {
  return effect.pipe(
    Effect.as(HttpServerResponse.jsonUnsafe(true)),
    Effect.catch(sessionFailure),
    Effect.catchDefect(sessionFailure),
  )
}

function noContentAfter(effect: Effect.Effect<unknown, unknown, unknown>) {
  return effect.pipe(
    Effect.as(HttpServerResponse.empty()),
    Effect.catch(sessionFailure),
    Effect.catchDefect(sessionFailure),
  )
}

function publishPromptAsyncError(sessionID: SessionID, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  log.error("prompt_async failed", { sessionID, error })
  void Bus.publish(SessionNs.Event.Error, {
    sessionID,
    error: new NamedError.Unknown({ message }).toObject(),
  })
}

function boolQuery(value: "true" | "false" | undefined) {
  return value === undefined ? undefined : value === "true"
}

function parseMessagesQuery(query: { limit?: number; before?: string }) {
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
    return badRequestJson({
      data: query,
      error: [{ message: "limit must be an integer greater than or equal to 0" }],
      success: false,
    })
  }
  if (query.before && query.limit === undefined) {
    return badRequestJson({
      data: query,
      error: [{ message: "before requires limit" }],
      success: false,
    })
  }
  if (query.before) {
    try {
      MessageV2.cursor.decode(query.before)
    } catch {
      return badRequestJson({
        data: query,
        error: [{ message: "Invalid cursor" }],
        success: false,
      })
    }
  }
  return query
}

export const sessionHandlers = HttpApiBuilder.group(SessionApi, "session", (handlers) =>
  handlers
    .handleRaw("list", (ctx) =>
      jsonResponse(
        SessionRouteEffects.listSessions({
          directory: ctx.query.directory,
          roots: boolQuery(ctx.query.roots),
          start: ctx.query.start,
          search: ctx.query.search,
          limit: ctx.query.limit,
          sort: ctx.query.sort,
        }),
      ),
    )
    .handleRaw("create", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionNs.create.schema.optional())
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(SessionRouteEffects.createSession(body))
      }),
    )
    .handleRaw("status", () =>
      SessionRouteEffects.getSessionStatus().pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(Object.fromEntries(result))),
        Effect.catch(sessionFailure),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("e2eUpdateTodos", (ctx) =>
      Effect.gen(function* () {
        if (!SessionRouteEffects.e2eSessionRoutesEnabled()) return HttpServerResponse.raw("404 Not Found", { status: 404 })
        const body = yield* parseJsonBody(ctx.request, E2EUpdateTodosBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* noContentAfter(SessionRouteEffects.updateE2ETodos(body))
      }),
    )
    .handleRaw("get", (ctx) => jsonResponse(SessionRouteEffects.getSession(ctx.params.sessionID)))
    .handleRaw("update", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionUpdateBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(
          SessionRouteEffects.updateSession({
            sessionID: ctx.params.sessionID,
            updates: body,
          }),
        )
      }),
    )
    .handleRaw("remove", (ctx) => okAfter(SessionRouteEffects.deleteSession(ctx.params.sessionID)))
    .handleRaw("children", (ctx) => jsonResponse(SessionRouteEffects.listSessionChildren(ctx.params.sessionID)))
    .handleRaw("init", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, InitBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* okAfter(SessionRouteEffects.initSession({ sessionID: ctx.params.sessionID, body }))
      }),
    )
    .handleRaw("messages", (ctx) =>
      Effect.gen(function* () {
        const query = parseMessagesQuery(ctx.query)
        if (HttpServerResponse.isHttpServerResponse(query)) return query
        return yield* SessionRouteEffects.listSessionMessages({
          sessionID: ctx.params.sessionID,
          limit: query.limit,
          before: query.before,
        })
      }).pipe(
        Effect.map((result) => {
          if (HttpServerResponse.isHttpServerResponse(result)) return result
          if (result.kind === "all") return HttpServerResponse.jsonUnsafe(result.items)

          const limit = ctx.query.limit!
          const headers =
            result.page.cursor === undefined
              ? undefined
              : (() => {
                  const url = new URL(ctx.request.url, "http://localhost")
                  url.searchParams.set("limit", limit.toString())
                  url.searchParams.set("before", result.page.cursor)
                  return {
                    "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
                    Link: `<${url.toString()}>; rel=\"next\"`,
                    "X-Next-Cursor": result.page.cursor,
                  }
                })()
          return HttpServerResponse.jsonUnsafe(result.page.items, { headers })
        }),
        Effect.catch(sessionFailure),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("prompt", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionPrompt.PromptInput.omit({ sessionID: true }))
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        const message = yield* SessionRouteEffects.promptSession({ ...body, sessionID: ctx.params.sessionID })
        return HttpServerResponse.raw(JSON.stringify(message), {
          contentType: "application/json",
        })
      }).pipe(Effect.catch(sessionFailure), Effect.catchDefect(sessionFailure)),
    )
    .handleRaw("message", (ctx) =>
      Effect.sync(() =>
        MessageV2.get({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
        }),
      ).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catch(sessionFailure),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("messageRemove", (ctx) =>
      okAfter(
        SessionRouteEffects.deleteSessionMessage({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
        }),
      ),
    )
    .handleRaw("partUpdate", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, MessageV2.Part)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        if (body.id !== ctx.params.partID || body.messageID !== ctx.params.messageID || body.sessionID !== ctx.params.sessionID) {
          return HttpServerResponse.jsonUnsafe(
            {
              success: false as const,
              errors: [
                {
                  message: `Part mismatch: body.id='${body.id}' vs partID='${ctx.params.partID}', body.messageID='${body.messageID}' vs messageID='${ctx.params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${ctx.params.sessionID}'`,
                },
              ],
              data: null,
            },
            { status: 400 },
          )
        }
        return yield* jsonResponse(SessionRouteEffects.updateSessionPart(body))
      }),
    )
    .handleRaw("partRemove", (ctx) =>
      okAfter(
        SessionRouteEffects.deleteSessionPart({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
          partID: ctx.params.partID,
        }),
      ),
    )
    .handleRaw("todo", (ctx) => jsonResponse(SessionRouteEffects.getSessionTodos(ctx.params.sessionID)))
    .handleRaw("promptAsync", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionPrompt.PromptInput.omit({ sessionID: true }))
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        const sessionID = ctx.params.sessionID
        yield* SessionRouteEffects.promptSession({ ...body, sessionID }).pipe(
          Effect.catch((error) => Effect.sync(() => publishPromptAsyncError(sessionID, error))),
          Effect.catchDefect((error) => Effect.sync(() => publishPromptAsyncError(sessionID, error))),
          Effect.forkDetach({ startImmediately: true }),
        )
        return HttpServerResponse.empty()
      }).pipe(Effect.catch(sessionFailure), Effect.catchDefect(sessionFailure)),
    )
    .handleRaw("abort", (ctx) =>
      jsonResponse(
        SessionRouteEffects.abortSession({
          sessionID: ctx.params.sessionID,
          source: ctx.query.source,
        }),
      ),
    )
    .handleRaw("command", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionPrompt.CommandInput.omit({ sessionID: true }))
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(SessionRouteEffects.runSessionCommand({ ...body, sessionID: ctx.params.sessionID }))
      }),
    )
    .handleRaw("fork", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionNs.fork.schema.omit({ sessionID: true }))
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(SessionRouteEffects.forkSession({ ...body, sessionID: ctx.params.sessionID }))
      }),
    )
    .handleRaw("diff", (ctx) =>
      jsonResponse(
        SessionRouteEffects.getSessionDiff({
          sessionID: ctx.params.sessionID,
          messageID: ctx.query.messageID,
        }),
      ),
    )
    .handleRaw("share", (ctx) =>
      SessionRouteEffects.shareSession(ctx.params.sessionID).pipe(
        Effect.map((result) => {
          if (!result.enabled) return HttpServerResponse.jsonUnsafe({ error: "cloud_share_disabled" }, { status: 410 })
          return HttpServerResponse.jsonUnsafe({
            ...result.session,
            share: result.share,
          })
        }),
        Effect.catch(sessionFailure),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("unshare", (ctx) =>
      SessionRouteEffects.unshareSession(ctx.params.sessionID).pipe(
        Effect.map((result) => {
          if (!result.enabled) return HttpServerResponse.jsonUnsafe({ error: "cloud_share_disabled" }, { status: 410 })
          return HttpServerResponse.jsonUnsafe({
            ...result.session,
            share: undefined,
          })
        }),
        Effect.catch(sessionFailure),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("summarize", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SummarizeBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* okAfter(
          SessionRouteEffects.summarizeSession({
            sessionID: ctx.params.sessionID,
            type: "compaction",
            model: {
              providerID: body.providerID,
              modelID: body.modelID,
            },
            auto: body.auto,
          }),
        )
      }),
    )
    .handleRaw("shell", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionPrompt.ShellInput.omit({ sessionID: true }))
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(SessionRouteEffects.runSessionShell({ ...body, sessionID: ctx.params.sessionID }))
      }),
    )
    .handleRaw("revert", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, SessionRevert.RevertInput.omit({ sessionID: true }))
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        log.info("revert", body)
        return yield* jsonResponse(SessionRouteEffects.revertSession({ ...body, sessionID: ctx.params.sessionID }))
      }),
    )
    .handleRaw("unrevert", (ctx) => jsonResponse(SessionRouteEffects.unrevertSession(ctx.params.sessionID)))
    .handleRaw("permission", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, PermissionBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* okAfter(
          SessionRouteEffects.replyToDeprecatedPermission({
            permissionID: ctx.params.permissionID as PermissionID,
            reply: body.response,
          }),
        )
      }),
    )
    .handleRaw("artifacts", (ctx) =>
      jsonResponse(
        SessionRouteEffects.listSessionArtifacts({
          sessionID: ctx.params.sessionID,
        }),
      ),
    )
    .handleRaw("export", (ctx) =>
      SessionRouteEffects.exportSession(ctx.params.sessionID).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catch((error) => {
          if (error instanceof NotFoundError) {
            return Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                {
                  error: "session_not_found",
                  sessionID: ctx.params.sessionID,
                },
                { status: 404 },
              ),
            )
          }
          return sessionFailure(error)
        }),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("toolRespond", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, ToolRespondBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body

        const { sessionID } = ctx.params
        const { messageID, callID } = body
        const lookup = ExternalResult.lookup({ sessionID, messageID, callID })
        if (lookup.state === "not_found") return HttpServerResponse.jsonUnsafe({ error: "no_pending_tool_call" }, { status: 404 })
        if (lookup.state === "resolved") return HttpServerResponse.jsonUnsafe({ error: "already_resolved" }, { status: 409 })

        const value =
          body.kind === "dismiss"
            ? ({ kind: "dismissed" } as const)
            : (() => {
                if (lookup.decoder) {
                  const decoded = lookup.decoder(body.payload, lookup.inputSnapshot)
                  if (!decoded.ok) {
                    return HttpServerResponse.jsonUnsafe(
                      { error: decoded.error, details: decoded.details },
                      { status: 422 },
                    )
                  }
                  return { kind: "submitted" as const, value: decoded.value }
                }
                return { kind: "submitted" as const, value: body.payload }
              })()
        if (HttpServerResponse.isHttpServerResponse(value)) return value

        const outcome = yield* SessionRouteEffects.resolveToolResponse({ sessionID, messageID, callID, value })
        if (outcome === "resolved") return HttpServerResponse.jsonUnsafe({ status: "ok" })
        if (outcome === "already_resolved") return HttpServerResponse.jsonUnsafe({ error: "already_resolved" }, { status: 409 })
        return HttpServerResponse.jsonUnsafe({ error: "no_pending_tool_call" }, { status: 404 })
      }).pipe(Effect.catch(sessionFailure), Effect.catchDefect(sessionFailure)),
    )
    .handleRaw("turnChange", (ctx) =>
      SessionRouteEffects.getTurnChange({
        sessionID: ctx.params.sessionID,
        messageID: ctx.params.messageID,
      }).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result ?? null)),
        Effect.catch(sessionFailure),
        Effect.catchDefect(sessionFailure),
      ),
    )
    .handleRaw("turnChangeUndo", (ctx) =>
      jsonResponse(
        SessionRouteEffects.undoTurnChange({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
        }),
      ),
    )
    .handleRaw("turnChangeRedo", (ctx) =>
      jsonResponse(
        SessionRouteEffects.redoTurnChange({
          sessionID: ctx.params.sessionID,
          messageID: ctx.params.messageID,
        }),
      ),
    )
    .handleRaw("aggregateChanges", (ctx) =>
      jsonResponse(
        SessionRouteEffects.getAggregateTurnChanges({
          sessionID: ctx.params.sessionID,
          userMessageID: ctx.params.userMessageID,
        }),
      ),
    )
    .handleRaw("aggregateUndo", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, OptionalForceBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(
          SessionRouteEffects.undoAggregateTurnChanges({
            sessionID: ctx.params.sessionID,
            userMessageID: ctx.params.userMessageID,
            force: body?.force,
          }),
        )
      }),
    )
    .handleRaw("aggregateRedo", (ctx) =>
      Effect.gen(function* () {
        const body = yield* parseJsonBody(ctx.request, OptionalForceBody)
        if (HttpServerResponse.isHttpServerResponse(body)) return body
        return yield* jsonResponse(
          SessionRouteEffects.redoAggregateTurnChanges({
            sessionID: ctx.params.sessionID,
            userMessageID: ctx.params.userMessageID,
            force: body?.force,
          }),
        )
      }),
    ),
)
