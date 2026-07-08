import { Effect, Schema } from "effect"
import { Automation, ValidationError } from "@/automation"
import { nextCronFireAfter } from "@/automation/derived"
import { AutomationScheduler } from "@/automation/scheduler"
import { validateModelAndVariantWith } from "@/automation/validation"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/db"
import * as Tool from "./tool"

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

// Flat LLM surface: every field is a scalar, no union/anyOf node, so models
// cannot serialize a nested object into a JSON string (the failure mode the
// old `where` and `rhythm` unions triggered in function-calling schemas).
// execute() translates this into the frozen Automation.CreateInput. Only
// title/prompt/cron are required; project, timezone, and model fall back to the
// calling session's context. recurring and continueSession are the two
// orthogonal behavioral opt-ins; both default to the safe side (recurring on,
// continueSession off). Interval/sub-minute cadence stays a UI/SDK power-user
// feature and is intentionally off the AI surface.
export const AutomateParameters = Schema.Struct({
  title: Title.annotate({ description: "Short name shown in the Automations panel." }),
  prompt: Prompt.annotate({
    description:
      "The instruction PawWork runs at the scheduled time. Include the action, recipient, data source, and any context needed then.",
  }),
  cron: CronExpression.annotate({
    description:
      '5-field cron expression, evaluated in the automation\'s timezone. Examples: "0 15 * * *" = 15:00 daily; "0 11 * * 1-5" = 11:00 on weekdays; "0 15 24 12 *" = 15:00 on Dec 24.',
  }),
  recurring: Schema.optional(Schema.Boolean).annotate({
    description:
      "Omit or true for a repeating schedule. Set false for a one-time task: it fires once at the next cron match. For a one-time task on a specific date, pin day-of-month and month in the cron expression and leave day-of-week as * — when both day fields are restricted, cron fires on either match, so the task would fire prematurely.",
  }),
  continueSession: Schema.optional(Schema.Boolean).annotate({
    description:
      "Set true only when the user explicitly wants this same conversation to continue on the schedule: every run is appended to this chat and sees prior runs, and deleting this conversation deletes the automation. Otherwise omit it; each run starts its own fresh background session.",
  }),
  timezone: Schema.optional(Timezone).annotate({
    description: 'IANA timezone, e.g. "Asia/Shanghai". Defaults to the host timezone.',
  }),
  model: Schema.optional(Schema.NonEmptyString).annotate({
    description: 'Optional "providerID/modelID" override. Defaults to this session\'s model.',
  }),
  variant: Schema.optional(Schema.NonEmptyString).annotate({
    description: "Optional reasoning-effort variant for the chosen model. Usually omit.",
  }),
})

export function formatAutomateValidationError(error: unknown) {
  const detail =
    error instanceof ValidationError
      ? error.details.map((item) => `${item.field}: ${item.message}`).join("\n")
      : String(error)
  return [
    "Invalid automate input.",
    "Expected: { title, prompt, cron, recurring?, continueSession?, timezone?, model?, variant? }.",
    'cron is a 5-field cron expression (e.g. "0 9 * * *" = 09:00 daily). recurring defaults to true; set it false for a one-shot that fires at the next cron match.',
    "continueSession defaults to false (each run executes in its own fresh background session); set it true to run the automation as a loop inside this conversation, appending every run to the current chat so it remembers prior runs.",
    'timezone defaults to the host timezone. model, when given, is a "providerID/modelID" string and otherwise defaults to this session\'s model; variant is an optional reasoning-effort key for that model.',
    'Example: { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" }.',
    detail,
  ].join("\n")
}

function readableAutomationError(error: unknown) {
  if (error instanceof ValidationError) return new Error(formatAutomateValidationError(error), { cause: error })
  return error
}

function resolveTimezone(explicit: string | undefined): string {
  if (explicit) return explicit
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone
  return system && Automation.isValidTimezone(system) ? system : "UTC"
}

// Model the automation inherits when the caller does not name one: the most
// recent user-message model on this session (matches plan.ts), else undefined.
// Best-effort — a missing session makes stream() throw NotFoundError, which we
// treat as "no model to inherit" and let execute() fall back to the provider
// default. Any other failure (corrupt store, IO, parse) propagates instead of
// silently downgrading the inherited model to the provider default.
function sessionModel(sessionID: SessionID) {
  try {
    for (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
  } catch (error) {
    if (NotFoundError.isInstance(error)) return undefined
    throw error
  }
  return undefined
}

export function createAutomateDefinition(
  provider: Provider.Interface,
  automation: Automation.Interface,
): Tool.DefWithoutID<typeof AutomateParameters, { automationDefinition: Automation.Definition }> {
  return {
    // Routing-first description: weak models match the user's own words ("remind
    // me", "later", "every weekday") against the first sentences, so triggers
    // lead and behavioral detail lives in the field descriptions above.
    description: [
      "Create a PawWork Automation: a scheduled task, reminder, recurring job, or background monitor that PawWork runs for the user. Use this whenever the user asks to do something later, at a specific time or date, one time, daily, weekly, on weekdays, or on any other schedule. Also use it to monitor, poll, watch, or check periodically over time, such as every 5 minutes, until a status changes, or when the user says to tell them when something happens. Never set up OS schedulers (at, cron, launchd, schtasks) for these requests unless the user explicitly asks for an OS-level scheduler outside PawWork.",
      "Automations appear in PawWork's Automations panel, where the user can pause or delete them, and each run uses this session's project context, model, and credentials. Creating the definition schedules the future run; it does not run the prompt now. After creating one, tell the user when it will fire (the result includes the schedule).",
    ].join("\n\n"),
    parameters: AutomateParameters,
    formatValidationError: formatAutomateValidationError,
    execute: Effect.fn("AutomateTool.execute")(function* (
      params: Schema.Schema.Type<typeof AutomateParameters>,
      ctx: Tool.Context,
    ) {
      const timezone = resolveTimezone(params.timezone)

      let model: { providerID: string; modelID: string }
      let variant: string | undefined
      if (params.model) {
        model = Provider.parseModel(params.model)
        variant = params.variant
      } else {
        const fromSession = sessionModel(ctx.sessionID)
        const inherited = fromSession ?? (yield* provider.defaultModel().pipe(Effect.orDie))
        model = { providerID: inherited.providerID, modelID: inherited.modelID }
        variant = params.variant ?? fromSession?.variant
      }

      const modelDetails = yield* validateModelAndVariantWith(provider, model, variant)
      if (modelDetails.length) {
        return yield* Effect.fail(readableAutomationError(new ValidationError(modelDetails)))
      }

      // Sample now only after model resolution/validation, which may have
      // yielded on I/O. Sampling earlier risks a one-shot fireAt computed from
      // a stale instant that a crossed cron boundary turns into an already-due
      // time.
      const now = Date.now()
      const parsed = yield* Effect.try({
        try: () => {
          // context defaults to "fresh" (each run gets its own background
          // session). continueSession opts into "continue", which runs the
          // automation inside THIS conversation (sourceSessionID): every run
          // appends to the current chat and sees prior runs. Default-fresh is
          // the safe side: defaulting to continue would attach every automation
          // the model creates to the live conversation.
          const common = {
            title: params.title,
            prompt: params.prompt,
            context: params.continueSession ? ("continue" as const) : ("fresh" as const),
            where: { projectID: Instance.project.id },
            timezone,
            model,
            ...(variant ? { variant } : {}),
          }
          // recurring defaults to true; a false flag is a one-shot whose fire
          // time is the next cron match (5-field cron has no year, so this is
          // "next occurrence", not an arbitrary far-future instant).
          const createInput =
            params.recurring === false
              ? (() => {
                  const fireAt = nextCronFireAfter(params.cron, timezone, now)
                  if (fireAt === null)
                    throw new ValidationError([{ field: "cron", message: "cron_has_no_future_fire" }])
                  return { kind: "oneshot" as const, ...common, fireAt }
                })()
              : {
                  kind: "recurring" as const,
                  ...common,
                  rhythm: { kind: "cron" as const, expression: params.cron },
                  stop: { kind: "never" as const },
                }
          const validated = Automation.CreateInput.parse(createInput)
          AutomationScheduler.current()
          return validated
        },
        catch: readableAutomationError,
      })
      // sourceSessionID always comes from ctx (this conversation), never from
      // input, so a model cannot spoof which chat a continue automation runs in.
      const definition = yield* automation
        .create(parsed, { now, sourceSessionID: ctx.sessionID })
        .pipe(Effect.mapError(readableAutomationError))
      yield* automation.publishDefinitionUpdated(definition)
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
    const automation = yield* Automation.Service
    return createAutomateDefinition(provider, automation)
  }),
)
