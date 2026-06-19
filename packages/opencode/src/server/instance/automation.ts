import { Hono } from "hono"
import type { Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Cause, Effect, Exit } from "effect"
import { Automation, ConflictError, ValidationError } from "@/automation"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
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
} from "./automation-actions"
import { errors } from "../error"

function runRoute(c: Context, effect: Effect.Effect<Response, unknown, AppServices>): Promise<Response> {
  return AppRuntime.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    const error = Cause.squash(exit.cause)
    if (error instanceof ValidationError) return c.json(validationError(error), 422)
    if (error instanceof ConflictError) return c.json(conflictError(error), 409)
    return Promise.reject(error)
  })
}

function runJsonRoute<A>(c: Context, effect: Effect.Effect<A, unknown, AppServices>): Promise<Response> {
  return runRoute(c, effect.pipe(Effect.map((body) => c.json(body))))
}

function automationBodyValidationHook(
  result: { success: true } | { success: false; error: readonly unknown[]; data: unknown },
  c: Context,
) {
  if (result.success) return
  return c.json(
    Automation.ValidationErrorResponse.parse({
      error: "invalid_automation",
      details: validationDetailsFromIssues(result.error, result.data),
    }),
    422,
  )
}

export const AutomationRoutes = (): Hono =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List automations",
        description: "List automation definitions for the current project.",
        operationId: "automation.list",
        responses: {
          200: {
            description: "Automation definitions",
            content: { "application/json": { schema: resolver(Automation.ListResponse) } },
          },
        },
      }),
      async (c) => runJsonRoute(c, listAutomations()),
    )
    .post(
      "/",
      describeRoute({
        summary: "Create automation",
        description: "Create an automation definition without executing it.",
        operationId: "automation.create",
        responses: {
          200: {
            description: "Created automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          422: {
            description: "Automation validation failed",
            content: { "application/json": { schema: resolver(Automation.ValidationErrorResponse) } },
          },
          ...errors(400),
        },
      }),
      validator("json", Automation.CreateInput, automationBodyValidationHook),
      async (c) => runJsonRoute(c, createAutomation(c.req.valid("json"))),
    )
    .get(
      "/:automationID",
      describeRoute({
        summary: "Get automation",
        description: "Get one automation definition.",
        operationId: "automation.get",
        responses: {
          200: {
            description: "Automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          ...errors(404),
        },
      }),
      validator("param", AutomationIDParam),
      async (c) => runJsonRoute(c, getAutomation(c.req.valid("param").automationID)),
    )
    .put(
      "/:automationID",
      describeRoute({
        summary: "Update automation",
        description: "Update an automation definition.",
        operationId: "automation.update",
        responses: {
          200: {
            description: "Updated automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          422: {
            description: "Automation validation failed",
            content: { "application/json": { schema: resolver(Automation.ValidationErrorResponse) } },
          },
          409: {
            description: "Automation update conflict",
            content: { "application/json": { schema: resolver(Automation.ConflictErrorResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", AutomationIDParam),
      validator("json", Automation.UpdateInput, automationBodyValidationHook),
      async (c) => runJsonRoute(c, updateAutomation(c.req.valid("param").automationID, c.req.valid("json"))),
    )
    .post(
      "/:automationID/pause",
      describeRoute({
        summary: "Pause automation",
        description: "Pause an automation definition.",
        operationId: "automation.pause",
        responses: {
          200: {
            description: "Paused automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          409: {
            description: "Automation update conflict",
            content: { "application/json": { schema: resolver(Automation.ConflictErrorResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", AutomationIDParam),
      async (c) => runJsonRoute(c, pauseAutomation(c.req.valid("param").automationID)),
    )
    .post(
      "/:automationID/resume",
      describeRoute({
        summary: "Resume automation",
        description: "Resume a paused automation definition.",
        operationId: "automation.resume",
        responses: {
          200: {
            description: "Resumed automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          409: {
            description: "Automation update conflict",
            content: { "application/json": { schema: resolver(Automation.ConflictErrorResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", AutomationIDParam),
      async (c) => runJsonRoute(c, resumeAutomation(c.req.valid("param").automationID)),
    )
    .delete(
      "/:automationID",
      describeRoute({
        summary: "Delete automation",
        description:
          "Delete an automation definition, cancel future scheduling, and return a tombstone. Already-started runs continue to completion.",
        operationId: "automation.delete",
        responses: {
          200: {
            description: "Automation deletion tombstone",
            content: { "application/json": { schema: resolver(Automation.Tombstone) } },
          },
          ...errors(404),
        },
      }),
      validator("param", AutomationIDParam),
      async (c) => runJsonRoute(c, deleteAutomation(c.req.valid("param").automationID)),
    )
    .post(
      "/:automationID/run",
      describeRoute({
        summary: "Run automation now",
        description: "Create a queued automation run, start execution in the background, and return the queued run immediately.",
        operationId: "automation.runNow",
        responses: {
          200: {
            description: "Automation run",
            content: { "application/json": { schema: resolver(Automation.Run) } },
          },
          ...errors(404),
        },
      }),
      validator("param", AutomationIDParam),
      async (c) => runJsonRoute(c, runAutomationNow(c.req.valid("param").automationID)),
    )
    .get(
      "/:automationID/runs",
      describeRoute({
        summary: "List automation runs",
        description: "List automation runs newest first.",
        operationId: "automation.runs",
        responses: {
          200: {
            description: "Automation runs",
            content: { "application/json": { schema: resolver(Automation.RunsResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", AutomationIDParam),
      validator("query", AutomationRunsQuery),
      async (c) => runJsonRoute(c, listAutomationRuns(c.req.valid("param").automationID, c.req.valid("query"))),
    )
