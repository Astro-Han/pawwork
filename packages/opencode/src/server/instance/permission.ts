import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { SessionID } from "@/session/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Env } from "@/env"
import { AppRuntime } from "@/effect/app-runtime"
import { Log } from "@opencode-ai/core/util/log"
import { SessionLiveness } from "@/session/liveness"
import { Effect } from "effect"

const log = Log.create({ service: "server" })
const e2ePermissionRoutesEnabled = () => Env.get("OPENCODE_E2E_ENABLED") === "true" && !!Env.get("OPENCODE_E2E_LLM_URL")
const runPermissionRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

const E2EPermissionAskBody = z.object({
  sessionID: SessionID.zod,
  permission: z.string().min(1),
  patterns: z.array(z.string()).min(1),
  metadata: z.record(z.string(), z.any()).optional(),
  always: z.array(z.string()).optional(),
})

type E2EPermissionAskBody = z.infer<typeof E2EPermissionAskBody>
type PermissionReplyBody = {
  reply: z.infer<typeof Permission.Reply>
  message?: string
}

const seedE2EPermissionAsk = Effect.fn("PermissionRoutes.e2e.ask")(function* (json: E2EPermissionAskBody) {
  const permission = yield* Permission.Service
  yield* permission.ask({
    sessionID: json.sessionID,
    permission: json.permission,
    patterns: json.patterns,
    metadata: json.metadata ?? {},
    always: json.always ?? json.patterns,
    ruleset: [{ permission: json.permission, pattern: "*", action: "ask" }],
  })
})

const replyToPermission = Effect.fn("PermissionRoutes.reply")(function* (
  requestID: PermissionID,
  json: PermissionReplyBody,
) {
  const permission = yield* Permission.Service
  yield* permission.reply({
    requestID,
    reply: json.reply,
    message: json.message,
  })
})

const listPendingPermissions = Effect.fn("PermissionRoutes.list")(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list().pipe(
    Effect.flatMap((items) =>
      SessionLiveness.pruneDangling(items, (sessionID) => permission.clearSession(sessionID, "dangling_session")),
    ),
  )
})

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/__e2e/ask",
      validator("json", E2EPermissionAskBody),
      async (c) => {
        if (!e2ePermissionRoutesEnabled()) return c.notFound()

        const json = c.req.valid("json")
        void runPermissionRoute(seedE2EPermissionAsk(json)).catch((error) => {
          log.error("e2e permission seed failed", { sessionID: json.sessionID, error })
        })

        return c.body(null, 204)
      },
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ reply: Permission.Reply, message: z.string().optional() })),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        await runPermissionRoute(replyToPermission(params.requestID, json))
        return c.json(true)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get all pending permission requests across all sessions.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(Permission.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const permissions = await runPermissionRoute(listPendingPermissions())
        return c.json(permissions)
      },
    ),
)
