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

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/__e2e/ask",
      validator(
        "json",
        z.object({
          sessionID: SessionID.zod,
          permission: z.string().min(1),
          patterns: z.array(z.string()).min(1),
          metadata: z.record(z.string(), z.any()).optional(),
          always: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        if (!e2ePermissionRoutesEnabled()) return c.notFound()

        const json = c.req.valid("json")
        void AppRuntime.runPromise(
          Permission.Service.use((svc) =>
            svc.ask({
              sessionID: json.sessionID,
              permission: json.permission,
              patterns: json.patterns,
              metadata: json.metadata ?? {},
              always: json.always ?? json.patterns,
              ruleset: [{ permission: json.permission, pattern: "*", action: "ask" }],
            }),
          ),
        ).catch((error) => {
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
        await Permission.reply({
          requestID: params.requestID,
          reply: json.reply,
          message: json.message,
        })
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
        const permissions = await AppRuntime.runPromise(
          Permission.Service.use((svc) =>
            svc.list().pipe(
              Effect.flatMap((items) => {
                const active = SessionLiveness.activeSessionIDs(items.map((item) => item.sessionID))
                const inactiveSessionIDs = new Set(
                  items.filter((item) => !active.has(item.sessionID)).map((item) => item.sessionID),
                )
                return Effect.gen(function* () {
                  for (const sessionID of inactiveSessionIDs) {
                    yield* svc.clearSession(sessionID, "dangling_session")
                  }
                  return items.filter((item) => active.has(item.sessionID))
                })
              }),
            ),
          ),
        )
        return c.json(permissions)
      },
    ),
)
