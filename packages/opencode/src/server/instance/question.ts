import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { QuestionID } from "@/question/schema"
import { Question } from "../../question"
import { AppRuntime } from "@/effect/app-runtime"
import { Bus } from "@/bus"
import { Env } from "@/env"
import { SessionID } from "@/session/schema"
import { Log } from "@opencode-ai/core/util/log"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "server" })

export const QuestionRoutes = lazy(() =>
  new Hono()
    // E2E-only hooks exercise question transport/UI flows without relying on flaky LLM seeding.
    .post(
      "/__e2e/ask",
      validator(
        "json",
        z.object({
          sessionID: SessionID.zod,
          questions: z.array(Question.Info.zod),
        }),
      ),
      async (c) => {
        if (!Env.get("OPENCODE_E2E_LLM_URL")) return c.notFound()

        const json = c.req.valid("json")
        void AppRuntime.runPromise(
          Question.Service.use((svc) =>
            svc.ask({
              sessionID: json.sessionID,
              questions: json.questions,
            }),
          ),
        ).catch((error) => {
          log.error("e2e question seed failed", { sessionID: json.sessionID, error })
        })

        return c.body(null, 204)
      },
    )
    .post(
      "/__e2e/publish-asked",
      validator(
        "json",
        z.object({
          request: Question.Request.zod,
        }),
      ),
      async (c) => {
        if (!Env.get("OPENCODE_E2E_LLM_URL")) return c.notFound()

        const json = c.req.valid("json")
        await AppRuntime.runPromise(Bus.Service.use((bus) => bus.publish(Question.Event.Asked, json.request)))

        return c.body(null, 204)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending questions",
        description: "Get all pending question requests across all sessions.",
        operationId: "question.list",
        responses: {
          200: {
            description: "List of pending questions",
            content: {
              "application/json": {
                schema: resolver(z.array(Question.Request.zod)),
              },
            },
          },
        },
      }),
      async (c) => {
        const questions = await AppRuntime.runPromise(Question.Service.use((svc) => svc.list()))
        return c.json(questions)
      },
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to question request",
        description: "Provide answers to a question request from the AI assistant.",
        operationId: "question.reply",
        responses: {
          200: {
            description: "Question answered successfully",
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
          requestID: QuestionID.zod,
        }),
      ),
      validator("json", Question.Reply.zod),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        await AppRuntime.runPromise(
          Question.Service.use((svc) =>
            svc.reply({
              requestID: params.requestID,
              answers: json.answers,
            }),
          ),
        )
        return c.json(true)
      },
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject question request",
        description: "Reject a question request from the AI assistant.",
        operationId: "question.reject",
        responses: {
          200: {
            description: "Question rejected successfully",
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
          requestID: QuestionID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await AppRuntime.runPromise(Question.Service.use((svc) => svc.reject(params.requestID)))
        return c.json(true)
      },
    ),
)
