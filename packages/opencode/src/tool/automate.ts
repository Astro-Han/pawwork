import { Effect, Schema } from "effect"
import { Automation } from "@/automation"
import * as Tool from "./tool"

const Where = Schema.Struct({
  projectID: Schema.String,
  worktree: Schema.optional(Schema.NonEmptyString),
})

const SessionIDString = Schema.String.check(Schema.isStartsWith("ses"))

const Common = {
  title: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  context: Schema.Union([Schema.Literal("continue"), Schema.Literal("fresh")]),
  where: Where,
  timezone: Schema.NonEmptyString,
  sourceSessionID: Schema.optional(SessionIDString),
  automationSessionID: Schema.optional(SessionIDString),
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const Stop = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("count"), count: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("condition"), condition: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("never") }),
])

const Rhythm = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interval"), everyMs: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("cron"), expression: Schema.NonEmptyString }),
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
  return [
    "Invalid automate input.",
    "Expected shape: oneshot { kind, title, prompt, context, where, timezone, fireAt } or recurring { kind, title, prompt, context, where, timezone, rhythm, stop }.",
    "Example: { kind: \"recurring\", title: \"Daily repo brief\", prompt: \"Summarize repo changes.\", context: \"fresh\", where: { projectID: \"current-project\" }, timezone: \"UTC\", rhythm: { kind: \"interval\", everyMs: 3600000 }, stop: { kind: \"never\" } }.",
    String(error),
  ].join("\n")
}

export function createAutomateDefinition(): Tool.DefWithoutID<typeof AutomateParameters, { automationDefinition: Automation.Definition }> {
  return {
    description:
      "Create an Automation definition for later execution. The automation is not executed by this tool; it only stores the definition and echoes the resolved contract.",
    parameters: AutomateParameters,
    formatValidationError: formatAutomateValidationError,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const parsed = Automation.CreateInput.parse({ ...params, sourceSessionID: params.sourceSessionID ?? ctx.sessionID })
        const definition = Automation.create(parsed)
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
