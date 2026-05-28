import { Effect, Schema } from "effect"
import { Automation } from "@/automation"
import * as Tool from "./tool"

const Where = Schema.Struct({
  projectID: Schema.String,
  worktree: Schema.optional(Schema.String),
})

const Common = {
  title: Schema.String,
  prompt: Schema.String,
  context: Schema.Literal("continue", "fresh"),
  where: Where,
  timezone: Schema.String,
  sourceSessionID: Schema.optional(Schema.String),
  automationSessionID: Schema.optional(Schema.String),
}

const Stop = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("count"), count: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("condition"), condition: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("never") }),
])

const Rhythm = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interval"), everyMs: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("cron"), expression: Schema.String }),
])

export const AutomateParameters = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("oneshot"),
    ...Common,
    fireAt: Schema.Number,
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
    execute: (params) =>
      Effect.gen(function* () {
        const parsed = Automation.CreateInput.parse(params)
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
