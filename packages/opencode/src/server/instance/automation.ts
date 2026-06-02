import { Hono } from "hono"
import type { Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { ActiveRunStillRunningError, Automation, AutomationID, ConflictError, ValidationError } from "@/automation"
import { sessionPromptExecutor } from "@/automation/runner"
import { AutomationScheduler } from "@/automation/scheduler"
import { validateModelAndVariant } from "@/automation/validation"
import { AppRuntime } from "@/effect/app-runtime"
import { errors } from "../error"

function validationError(error: ValidationError) {
  return Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: error.details })
}

function conflictError(error: ConflictError) {
  return Automation.ConflictErrorResponse.parse({ error: "automation_conflict", message: error.message })
}

function activeRunStillRunningError(error: ActiveRunStillRunningError) {
  return Automation.ActiveRunStillRunningErrorResponse.parse({
    error: "active_run_still_running",
    runID: error.runID,
  })
}

async function publishIfChanged(previous: Automation.Definition, definition: Automation.Definition) {
  if (definition.revision === previous.revision) return
  await Automation.publishDefinitionUpdated(definition)
}

async function settleAutomationScheduler() {
  await AutomationScheduler.current().settleOwner()
}

async function modelValidationDetails(model: Automation.Model, variant?: string) {
  if (process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION === "1") return []
  return AppRuntime.runPromise(validateModelAndVariant(model, variant))
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
      async (c) => {
        await settleAutomationScheduler()
        return c.json({ items: Automation.list() })
      },
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
          await settleAutomationScheduler()
          const input = c.req.valid("json")
          const modelDetails = await modelValidationDetails(input.model, input.variant)
          if (modelDetails.length) {
            return c.json(
              Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: modelDetails }),
              422,
            )
          }
          const definition = Automation.create(input)
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
      async (c) => {
        await settleAutomationScheduler()
        return c.json(Automation.get(c.req.valid("param").automationID))
      },
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
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      validator("json", Automation.UpdateInput, automationBodyValidationHook),
      async (c) => {
        try {
          const automationID = c.req.valid("param").automationID
          await settleAutomationScheduler()
          const previous = Automation.get(automationID)
          const patch = c.req.valid("json")
          if (patch.model !== undefined || patch.variant !== undefined) {
            const effectiveModel = patch.model ?? previous.model
            const effectiveVariant = patch.variant === null ? undefined : (patch.variant ?? previous.variant)
            const modelDetails = await modelValidationDetails(effectiveModel, effectiveVariant)
            if (modelDetails.length) {
              return c.json(
                Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: modelDetails }),
                422,
              )
            }
          }
          const definition = Automation.update(automationID, patch)
          await publishIfChanged(previous, definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ValidationError) return c.json(validationError(error), 422)
          if (error instanceof ConflictError) return c.json(conflictError(error), 409)
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
          409: {
            description: "Automation update conflict",
            content: { "application/json": { schema: resolver(Automation.ConflictErrorResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        try {
          const automationID = c.req.valid("param").automationID
          await settleAutomationScheduler()
          const previous = Automation.get(automationID)
          const definition = Automation.update(automationID, { paused: true })
          await publishIfChanged(previous, definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ConflictError) return c.json(conflictError(error), 409)
          throw error
        }
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
          409: {
            description: "Automation update conflict",
            content: { "application/json": { schema: resolver(Automation.ConflictErrorResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        try {
          const automationID = c.req.valid("param").automationID
          await settleAutomationScheduler()
          const previous = Automation.get(automationID)
          const definition = Automation.update(automationID, { paused: false })
          await publishIfChanged(previous, definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ConflictError) return c.json(conflictError(error), 409)
          throw error
        }
      },
    )
    .delete(
      "/:automationID",
      describeRoute({
        summary: "Delete automation",
        description:
          "Delete an automation definition and return a tombstone. If a run is active in this process, stop it and publish the stopped run before publishing the tombstone. If a live run is owned by another process, return 409 without deleting.",
        operationId: "automation.delete",
        responses: {
          200: {
            description: "Automation deletion tombstone",
            content: { "application/json": { schema: resolver(Automation.Tombstone) } },
          },
          409: {
            description: "Automation has a live run owned by another process",
            content: { "application/json": { schema: resolver(Automation.ActiveRunStillRunningErrorResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        try {
          const scheduler = AutomationScheduler.current()
          await scheduler.settleOwner()
          const removed = await Automation.remove(c.req.valid("param").automationID)
          scheduler.cancel(removed.tombstone.id)
          if (removed.stoppedRun) await Automation.publishRunUpdated(removed.stoppedRun)
          await Automation.publishDefinitionDeleted(removed.tombstone)
          return c.json(removed.tombstone)
        } catch (error) {
          if (error instanceof ActiveRunStillRunningError) return c.json(activeRunStillRunningError(error), 409)
          throw error
        }
      },
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
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        await settleAutomationScheduler()
        const run = await Automation.runNowExecuting(c.req.valid("param").automationID, {
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
      async (c) => {
        await settleAutomationScheduler()
        return c.json(Automation.runs({ automationID: c.req.valid("param").automationID, ...c.req.valid("query") }))
      },
    )
