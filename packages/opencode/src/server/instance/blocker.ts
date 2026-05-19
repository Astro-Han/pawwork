import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { AppRuntime } from "@/effect/app-runtime"
import { SessionBlocker } from "@/session/blocker"
import { lazy } from "../../util/lazy"
import { Env } from "@/env"
import { SessionLiveness } from "@/session/liveness"
import { Effect } from "effect"

const e2eBlockerRoutesEnabled = () => Env.get("OPENCODE_E2E_ENABLED") === "true" && !!Env.get("OPENCODE_E2E_LLM_URL")

export const BlockerRoutes = lazy(() =>
  new Hono()
    .post("/__e2e/publish-upserted", async (c) => {
      if (!e2eBlockerRoutesEnabled()) return c.notFound()
      const json = await c.req.json()
      await AppRuntime.runPromise(
        SessionBlocker.Service.use((svc) => svc.upsertQuestion(SessionBlocker.QuestionRequest.parse(json.request))),
      )
      return c.body(null, 204)
    })
    .get(
      "/",
      describeRoute({
        summary: "List active session blockers",
        description: "Get active session blockers across all sessions.",
        operationId: "blocker.list",
        responses: {
          200: {
            description: "List of active session blockers",
            content: {
              "application/json": {
                schema: resolver(z.array(SessionBlocker.Entry)),
              },
            },
          },
        },
      }),
      async (c) => {
        const blockers = await AppRuntime.runPromise(
          SessionBlocker.Service.use((svc) =>
            svc
              .list()
              .pipe(
                Effect.flatMap((items) =>
                  SessionLiveness.pruneDangling(items, (sessionID) => svc.clearSession(sessionID, "dangling_session")),
                ),
              ),
          ),
        )
        return c.json(blockers)
      },
    ),
)
