import { Effect, Schema } from "effect"
import { Automation, ValidationError } from "@/automation"
import { AutomationScheduler } from "@/automation/scheduler"
import { validateModelAndVariantWith } from "@/automation/validation"
import { Provider } from "@/provider/provider"
import * as Tool from "./tool"

const Where = Schema.Struct({
  projectID: Schema.String,
  worktree: Schema.optional(Schema.NonEmptyString),
})

const Model = Schema.Struct({
  providerID: Schema.NonEmptyString,
  modelID: Schema.NonEmptyString,
})

const Timezone = Schema.NonEmptyString.check(
  Schema.makeFilter((timezone: string) => (Automation.isValidTimezone(timezone) ? undefined : "invalid_timezone")),
)
const CronExpression = Schema.NonEmptyString.check(
  Schema.makeFilter((expression: string) =>
    Automation.isValidCronExpression(expression) ? undefined : "invalid_cron_expression",
  ),
)
const Title = Schema.NonEmptyString.check(Schema.isMaxLength(Automation.MAX_TITLE_CHARS))
const Prompt = Schema.NonEmptyString.check(Schema.isMaxLength(Automation.MAX_PROMPT_CHARS))
const Condition = Schema.NonEmptyString.check(Schema.isMaxLength(Automation.MAX_CONDITION_CHARS))

const Common = {
  title: Title,
  prompt: Prompt,
  context: Schema.Union([Schema.Literal("continue"), Schema.Literal("fresh")]),
  where: Where,
  timezone: Timezone,
  model: Model,
  variant: Schema.optional(Schema.NonEmptyString),
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const IntervalMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(Automation.MIN_INTERVAL_MS))

// Mirrors Automation.Stop. `kind: "condition"` is currently rejected at
// validate time with { field: "stop", message: "unsupported_stop_condition" };
// kept in the schema so the structured error contract matches HTTP routes.
// The tool description below points the LLM away from condition.
const Stop = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("count"), count: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("condition"), condition: Condition }),
  Schema.Struct({ kind: Schema.Literal("never") }),
])

const Rhythm = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interval"), everyMs: IntervalMs }),
  Schema.Struct({ kind: Schema.Literal("cron"), expression: CronExpression }),
])

export const AutomateParameters = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("oneshot"),
    ...Common,
    fireAt: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("recurring"),
    ...Common,
    rhythm: Rhythm,
    stop: Stop,
  }),
])

export function formatAutomateValidationError(error: unknown) {
  const detail =
    error instanceof ValidationError
      ? error.details.map((item) => `${item.field}: ${item.message}`).join("\n")
      : String(error)
  return [
    "Invalid automate input.",
    "Expected shape: oneshot { kind, title, prompt, context, where, timezone, model, variant?, fireAt } or recurring { kind, title, prompt, context, where, timezone, model, variant?, rhythm, stop }.",
    "model is required as { providerID, modelID }; variant is optional and must be a valid effort key for that model (omit for models without reasoning).",
    "stop only supports { kind: \"count\", count } or { kind: \"never\" } today; { kind: \"condition\" } is reserved and currently rejected.",
    "Example: { kind: \"recurring\", title: \"Daily repo brief\", prompt: \"Summarize repo changes.\", context: \"fresh\", where: { projectID: \"current-project\" }, timezone: \"UTC\", model: { providerID: \"anthropic\", modelID: \"claude-sonnet-4-6\" }, variant: \"high\", rhythm: { kind: \"interval\", everyMs: 3600000 }, stop: { kind: \"never\" } }.",
    detail,
  ].join("\n")
}

function readableAutomationError(error: unknown) {
  if (error instanceof ValidationError) return new Error(formatAutomateValidationError(error), { cause: error })
  return error
}

export function createAutomateDefinition(provider: Provider.Interface): Tool.DefWithoutID<typeof AutomateParameters, { automationDefinition: Automation.Definition }> {
  return {
    description:
      "Create an Automation definition for later execution. The automation is not executed by this tool; it only stores the definition and echoes the resolved contract.",
    parameters: AutomateParameters,
    formatValidationError: formatAutomateValidationError,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const { sourceSessionID: _ignoredSourceSessionID, ...input } = params as typeof params & { sourceSessionID?: unknown }
        if (Object.hasOwn(input, "automationSessionID")) {
          return yield* Effect.fail(
            readableAutomationError(
              new ValidationError([{ field: "automationSessionID", message: "unsupported_automation_field" }]),
            ),
          )
        }
        const modelDetails = yield* validateModelAndVariantWith(provider, input.model, input.variant)
        if (modelDetails.length) {
          return yield* Effect.fail(readableAutomationError(new ValidationError(modelDetails)))
        }
        const definition = yield* Effect.try({
          try: () => {
            const parsed = Automation.CreateInput.parse(input)
            AutomationScheduler.current()
            return Automation.create(parsed, { sourceSessionID: ctx.sessionID })
          },
          catch: readableAutomationError,
        })
        yield* Effect.promise(() => Automation.publishDefinitionUpdated(definition))
        return {
          title: "Automation created",
          metadata: { automationDefinition: definition },
          output: JSON.stringify(definition, null, 2),
        }
      }),
  }
}

export const AutomateTool = Tool.define(
  "automate",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return createAutomateDefinition(provider)
  }),
)
