import { Hono } from "hono"
import type { Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Cause, Effect, Exit } from "effect"
import z from "zod"
import { Automation, AutomationID, ConflictError, ValidationError } from "@/automation"
import { sessionPromptExecutor } from "@/automation/runner"
import { AutomationScheduler } from "@/automation/scheduler"
import { validateModelAndVariant } from "@/automation/validation"
import { Provider } from "@/provider/provider"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { errors } from "../error"

function validationError(error: ValidationError) {
  return Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: error.details })
}

function conflictError(error: ConflictError) {
  return Automation.ConflictErrorResponse.parse({ error: "automation_conflict", message: error.message })
}

const AutomationIDParam = z.object({ automationID: AutomationID.Definition.zod })
const AutomationRunsQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: AutomationID.Run.zod.optional(),
})

type AutomationIDParam = z.infer<typeof AutomationIDParam>
type AutomationRunsQuery = z.infer<typeof AutomationRunsQuery>

const settleAutomationScheduler = Effect.fn("AutomationRoutes.scheduler.settle")(function* (
  scheduler: Pick<AutomationScheduler.Interface, "settleOwner"> = AutomationScheduler.current(),
) {
  yield* Effect.promise(() => scheduler.settleOwner())
})

function modelValidation(
  model: Automation.Model,
  variant?: string,
): Effect.Effect<Automation.ValidationErrorDetail[], never, Provider.Service> {
  if (process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION === "1") return Effect.succeed([])
  return validateModelAndVariant(model, variant)
}

function runRoute(c: Context, effect: Effect.Effect<Response, unknown, AppServices>): Promise<Response> {
  return AppRuntime.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    const error = Cause.squash(exit.cause)
    if (error instanceof ValidationError) return c.json(validationError(error), 422)
    if (error instanceof ConflictError) return c.json(conflictError(error), 409)
    return Promise.reject(error)
  })
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

const listAutomations = Effect.fn("AutomationRoutes.list")(function* (c: Context) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const items = yield* automation.list()
  return c.json({ items })
})

const createAutomation = Effect.fn("AutomationRoutes.create")(function* (c: Context, input: Automation.CreateInput) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const modelDetails = yield* modelValidation(input.model, input.variant)
  if (modelDetails.length) {
    return c.json(Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: modelDetails }), 422)
  }
  const definition = yield* automation.create(input)
  yield* automation.publishDefinitionUpdated(definition)
  return c.json(definition)
})

const getAutomation = Effect.fn("AutomationRoutes.get")(function* (c: Context, automationID: AutomationIDParam["automationID"]) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  return c.json(yield* automation.get(automationID))
})

const updateAutomation = Effect.fn("AutomationRoutes.update")(function* (
  c: Context,
  automationID: AutomationIDParam["automationID"],
  patch: Automation.UpdateInput,
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const previous = yield* automation.get(automationID)
  if (patch.model !== undefined || patch.variant !== undefined) {
    const effectiveModel = patch.model ?? previous.model
    const effectiveVariant = patch.variant === null ? undefined : (patch.variant ?? previous.variant)
    const modelDetails = yield* modelValidation(effectiveModel, effectiveVariant)
    if (modelDetails.length) {
      return c.json(Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: modelDetails }), 422)
    }
  }
  const definition = yield* automation.update(automationID, patch)
  if (definition.revision !== previous.revision) {
    if (definition.where.projectID !== previous.where.projectID) {
      yield* automation.publishDefinitionDeleted({ id: previous.id, deleted: true, revision: definition.revision })
      yield* automation.publishDefinitionUpdatedForScope(definition, Automation.getScope(definition.id))
    } else {
      yield* automation.publishDefinitionUpdated(definition)
    }
  }
  return c.json(definition)
})

const pauseAutomation = Effect.fn("AutomationRoutes.pause")(function* (
  c: Context,
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const previous = yield* automation.get(automationID)
  const definition = yield* automation.update(automationID, { paused: true })
  if (definition.revision !== previous.revision) {
    yield* automation.publishDefinitionUpdated(definition)
  }
  return c.json(definition)
})

const resumeAutomation = Effect.fn("AutomationRoutes.resume")(function* (
  c: Context,
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const previous = yield* automation.get(automationID)
  const definition = yield* automation.update(automationID, { paused: false })
  if (definition.revision !== previous.revision) {
    yield* automation.publishDefinitionUpdated(definition)
  }
  return c.json(definition)
})

const deleteAutomation = Effect.fn("AutomationRoutes.delete")(function* (
  c: Context,
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  const scheduler = AutomationScheduler.current()
  yield* settleAutomationScheduler(scheduler)
  const removed = yield* automation.remove(automationID)
  yield* Effect.sync(() => scheduler.cancel(removed.tombstone.id))
  yield* automation.publishDefinitionDeleted(removed.tombstone)
  return c.json(removed.tombstone)
})

const runAutomationNow = Effect.fn("AutomationRoutes.runNow")(function* (
  c: Context,
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const run = yield* automation.runNowExecuting(automationID, {
    executor: sessionPromptExecutor,
  })
  yield* automation.publishRunUpdated(run)
  return c.json(run)
})

const listAutomationRuns = Effect.fn("AutomationRoutes.runs")(function* (
  c: Context,
  automationID: AutomationIDParam["automationID"],
  query: AutomationRunsQuery,
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  return c.json(yield* automation.runs({ automationID, ...query }))
})

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
      async (c) => runRoute(c, listAutomations(c)),
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
      async (c) => runRoute(c, createAutomation(c, c.req.valid("json"))),
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
      async (c) => runRoute(c, getAutomation(c, c.req.valid("param").automationID)),
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
      async (c) => runRoute(c, updateAutomation(c, c.req.valid("param").automationID, c.req.valid("json"))),
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
      async (c) => runRoute(c, pauseAutomation(c, c.req.valid("param").automationID)),
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
      async (c) => runRoute(c, resumeAutomation(c, c.req.valid("param").automationID)),
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
      async (c) => runRoute(c, deleteAutomation(c, c.req.valid("param").automationID)),
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
      async (c) => runRoute(c, runAutomationNow(c, c.req.valid("param").automationID)),
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
      async (c) => runRoute(c, listAutomationRuns(c, c.req.valid("param").automationID, c.req.valid("query"))),
    )
