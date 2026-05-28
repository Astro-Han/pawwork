import { Effect, Schema } from "effect"
import { Automation, ValidationError } from "@/automation"
import * as Tool from "./tool"

const Where = Schema.Struct({
  projectID: Schema.String,
  worktree: Schema.optional(Schema.NonEmptyString),
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
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const IntervalMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(Automation.MIN_INTERVAL_MS))

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
    "Expected shape: oneshot { kind, title, prompt, context, where, timezone, fireAt } or recurring { kind, title, prompt, context, where, timezone, rhythm, stop }.",
    "Example: { kind: \"recurring\", title: \"Daily repo brief\", prompt: \"Summarize repo changes.\", context: \"fresh\", where: { projectID: \"current-project\" }, timezone: \"UTC\", rhythm: { kind: \"interval\", everyMs: 3600000 }, stop: { kind: \"never\" } }.",
    detail,
  ].join("\n")
}

function readableAutomationError(error: unknown) {
  if (error instanceof ValidationError) return new Error(formatAutomateValidationError(error), { cause: error })
  return error
}

export function createAutomateDefinition(): Tool.DefWithoutID<typeof AutomateParameters, { automationDefinition: Automation.Definition }> {
  return {
    description:
      "Create an Automation definition for later execution. The automation is not executed by this tool; it only stores the definition and echoes the resolved contract.",
    parameters: AutomateParameters,
    formatValidationError: formatAutomateValidationError,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const definition = yield* Effect.try({
          try: () => {
            if (Object.hasOwn(params as object, "automationSessionID")) {
              throw new ValidationError([{ field: "automationSessionID", message: "unsupported_automation_field" }])
            }
            const { sourceSessionID: _ignoredSourceSessionID, ...input } = params as typeof params & { sourceSessionID?: unknown }
            const parsed = Automation.CreateInput.parse(input)
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

export const AutomateTool = Tool.define("automate", Effect.succeed(createAutomateDefinition()))
