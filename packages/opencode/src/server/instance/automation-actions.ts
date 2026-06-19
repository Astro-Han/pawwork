import { Automation, AutomationID, ConflictError, ValidationError } from "@/automation"
import { sessionPromptExecutor } from "@/automation/runner"
import { AutomationScheduler } from "@/automation/scheduler"
import { validateModelAndVariant } from "@/automation/validation"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import z from "zod"

export const AutomationIDParam = z.object({ automationID: AutomationID.Definition.zod })
export const AutomationRunsQuery = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: AutomationID.Run.zod.optional(),
})

export type AutomationIDParam = z.infer<typeof AutomationIDParam>
export type AutomationRunsQuery = z.infer<typeof AutomationRunsQuery>

export function validationError(error: ValidationError) {
  return Automation.ValidationErrorResponse.parse({ error: "invalid_automation", details: error.details })
}

export function conflictError(error: ConflictError) {
  return Automation.ConflictErrorResponse.parse({ error: "automation_conflict", message: error.message })
}

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

function validationIssuePath(issue: unknown) {
  const path = typeof issue === "object" && issue !== null && "path" in issue ? issue.path : undefined
  if (!Array.isArray(path)) return ""
  return path.map((part) => String(part)).join(".")
}

export function validationDetailsFromIssues(
  issues: readonly unknown[],
  data: unknown,
): Automation.ValidationErrorDetail[] {
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

export const listAutomations = Effect.fn("AutomationRoutes.list")(function* () {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const items = yield* automation.list()
  return { items }
})

export const createAutomation = Effect.fn("AutomationRoutes.create")(function* (input: Automation.CreateInput) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const modelDetails = yield* modelValidation(input.model, input.variant)
  if (modelDetails.length) {
    return yield* Effect.fail(new ValidationError(modelDetails))
  }
  const definition = yield* automation.create(input)
  yield* automation.publishDefinitionUpdated(definition)
  return definition
})

export const getAutomation = Effect.fn("AutomationRoutes.get")(function* (
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  return yield* automation.get(automationID)
})

export const updateAutomation = Effect.fn("AutomationRoutes.update")(function* (
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
      return yield* Effect.fail(new ValidationError(modelDetails))
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
  return definition
})

export const pauseAutomation = Effect.fn("AutomationRoutes.pause")(function* (
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const previous = yield* automation.get(automationID)
  const definition = yield* automation.update(automationID, { paused: true })
  if (definition.revision !== previous.revision) {
    yield* automation.publishDefinitionUpdated(definition)
  }
  return definition
})

export const resumeAutomation = Effect.fn("AutomationRoutes.resume")(function* (
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const previous = yield* automation.get(automationID)
  const definition = yield* automation.update(automationID, { paused: false })
  if (definition.revision !== previous.revision) {
    yield* automation.publishDefinitionUpdated(definition)
  }
  return definition
})

export const deleteAutomation = Effect.fn("AutomationRoutes.delete")(function* (
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  const scheduler = AutomationScheduler.current()
  yield* settleAutomationScheduler(scheduler)
  const removed = yield* automation.remove(automationID)
  yield* Effect.sync(() => scheduler.cancel(removed.tombstone.id))
  yield* automation.publishDefinitionDeleted(removed.tombstone)
  return removed.tombstone
})

export const runAutomationNow = Effect.fn("AutomationRoutes.runNow")(function* (
  automationID: AutomationIDParam["automationID"],
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  const run = yield* automation.runNowExecuting(automationID, {
    executor: sessionPromptExecutor,
  })
  yield* automation.publishRunUpdated(run)
  return run
})

export const listAutomationRuns = Effect.fn("AutomationRoutes.runs")(function* (
  automationID: AutomationIDParam["automationID"],
  query: AutomationRunsQuery,
) {
  const automation = yield* Automation.Service
  yield* settleAutomationScheduler()
  return yield* automation.runs({ automationID, ...query })
})
