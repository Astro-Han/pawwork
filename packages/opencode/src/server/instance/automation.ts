import { Hono } from "hono"
import type { Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Automation, AutomationID, ValidationError } from "@/automation"
import { sessionPromptExecutor } from "@/automation/runner"
import { errors } from "../error"

function validationError(error: ValidationError) {
  return Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: error.details })
}

async function publishIfChanged(previous: Automation.Definition, definition: Automation.Definition) {
  if (definition.revision === previous.revision) return
  await Automation.publishDefinitionUpdated(definition)
}

function validationIssuePath(issue: unknown) {
  const path = typeof issue === "object" && issue !== null && "path" in issue ? issue.path : undefined
  if (!Array.isArray(path)) return ""
  return path.map((part) => String(part)).join(".")
}

function validationDetailsFromIssues(issues: readonly unknown[], data: unknown): Automation.ValidationErrorDetail[] {
  const kind =
    typeof data === "object" && data !== null && "kind" in data && typeof data.kind === "string" ? data.kind : undefined
  return issues.flatMap((issue) => {
    const path = validationIssuePath(issue)
    if (typeof issue === "object" && issue !== null && "code" in issue && issue.code === "unrecognized_keys") {
      const keys = "keys" in issue && Array.isArray(issue.keys) ? issue.keys : []
      return keys.map((key) => {
        const field = path ? `${path}.${String(key)}` : String(key)
        if (kind === "oneshot" && (field === "rhythm" || field === "stop")) {
          return { field, message: "unsupported_for_oneshot_automation" }
        }
        if (kind === "recurring" && field === "fireAt") {
          return { field, message: "unsupported_for_recurring_automation" }
        }
        return { field, message: "unsupported_automation_field" }
      })
    }
    const field = path
    const message =
      typeof issue === "object" && issue !== null && "message" in issue && typeof issue.message === "string"
        ? issue.message
        : "invalid_automation_field"
    return [{ field, message }]
  })
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
      (c) => c.json({ items: Automation.list() }),
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
      async (c) => {
        try {
          const definition = Automation.create(c.req.valid("json"))
          await Automation.publishDefinitionUpdated(definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ValidationError) return c.json(validationError(error), 422)
          throw error
        }
      },
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
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      (c) => c.json(Automation.get(c.req.valid("param").automationID)),
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
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      validator("json", Automation.UpdateInput, automationBodyValidationHook),
      async (c) => {
        try {
          const automationID = c.req.valid("param").automationID
          const previous = Automation.get(automationID)
          const definition = Automation.update(automationID, c.req.valid("json"))
          await publishIfChanged(previous, definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ValidationError) return c.json(validationError(error), 422)
          throw error
        }
      },
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
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const automationID = c.req.valid("param").automationID
        const previous = Automation.get(automationID)
        const definition = Automation.update(automationID, { paused: true })
        await publishIfChanged(previous, definition)
        return c.json(definition)
      },
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
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const automationID = c.req.valid("param").automationID
        const previous = Automation.get(automationID)
        const definition = Automation.update(automationID, { paused: false })
        await publishIfChanged(previous, definition)
        return c.json(definition)
      },
    )
    .delete(
      "/:automationID",
      describeRoute({
        summary: "Delete automation",
        description: "Delete an automation definition and return a tombstone.",
        operationId: "automation.delete",
        responses: {
          200: {
            description: "Automation deletion tombstone",
            content: { "application/json": { schema: resolver(Automation.Tombstone) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const tombstone = Automation.remove(c.req.valid("param").automationID)
        await Automation.publishDefinitionDeleted(tombstone)
        return c.json(tombstone)
      },
    )
    .post(
      "/:automationID/run",
      describeRoute({
        summary: "Run automation now",
        description: "Create a scheduled automation run record and start execution in the background.",
        operationId: "automation.runNow",
        responses: {
          200: {
            description: "Automation run",
            content: { "application/json": { schema: resolver(Automation.Run) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const run = Automation.runNowExecuting(c.req.valid("param").automationID, {
          executor: sessionPromptExecutor,
        })
        await Automation.publishRunUpdated(run)
        return c.json(run)
      },
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
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().int().positive().max(100).optional(),
          cursor: AutomationID.Run.zod.optional(),
        }),
      ),
      (c) => c.json(Automation.runs({ automationID: c.req.valid("param").automationID, ...c.req.valid("query") })),
    )
