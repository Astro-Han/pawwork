import { Effect, Schema } from "effect"
import { ActiveRunStillRunningError, Automation } from "@/automation"
import { AutomationScheduler } from "@/automation/scheduler"
import * as Tool from "./tool"

const Action = Schema.Literals(["list", "pause", "resume", "delete"])

export const AutomateManageParameters = Schema.Struct({
  action: Action.annotate({
    description:
      'Management action for an existing PawWork Automation: "list", "pause", "resume", or "delete".',
  }),
  id: Schema.optional(Schema.String).annotate({
    description:
      "Exact automation id from automate_manage list or an automate creation result. Required for pause, resume, and delete; omit for list.",
  }),
})

type Parameters = Schema.Schema.Type<typeof AutomateManageParameters>
type Metadata = {
  automationDefinitions?: Automation.Definition[]
  automationDefinition?: Automation.Definition
  automationTombstone?: Automation.Tombstone
  stoppedRun?: Automation.Run
}

function schedule(definition: Automation.Definition) {
  if (definition.kind === "oneshot") return new Date(definition.fireAt).toISOString()
  if (definition.rhythm.kind === "cron") return definition.rhythm.expression
  return `every ${definition.rhythm.everyMs}ms`
}

function item(definition: Automation.Definition) {
  return {
    id: definition.id,
    title: definition.title,
    kind: definition.kind,
    paused: definition.paused,
    schedule: schedule(definition),
    timezone: definition.timezone,
    context: definition.context,
    nextFireAt: definition.kind === "recurring" ? definition.nextFireAt : undefined,
  }
}

function requireID(params: Parameters) {
  if (params.id) return params.id
  throw new Error(`automate_manage action "${params.action}" requires an exact automation id.`)
}

function readableAutomationError(error: unknown, id: string) {
  if (error instanceof ActiveRunStillRunningError) {
    return new Error(
      `Cannot delete automation ${id}: active_run_still_running (${error.runID}). Try again after the active run finishes.`,
      { cause: error },
    )
  }
  return error
}

export function createAutomateManageDefinition(
  automation: Automation.Interface,
): Tool.DefWithoutID<typeof AutomateManageParameters, Metadata> {
  return {
    description: [
      "Manage existing PawWork Automations from the conversation. Use this when the user asks to show scheduled tasks, list reminders, pause an automation, resume an automation, or delete/remove/cancel an automation. Never use OS schedulers (crontab, cron, at, launchd, schtasks) to manage PawWork Automations.",
      "Use action list first when the user has not provided an exact automation id. Pause and resume are reversible and do not need confirmation. Delete is destructive and must ask the user for confirmation before removing anything.",
    ].join("\n\n"),
    parameters: AutomateManageParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const scheduler = AutomationScheduler.current()
        yield* Effect.promise(() => scheduler.settleOwner())

        if (params.action === "list") {
          const items = yield* automation.list()
          return {
            title: "Automations",
            metadata: { automationDefinitions: items },
            output: JSON.stringify({ items: items.map(item) }, null, 2),
          }
        }

        const id = requireID(params)
        const previous = yield* automation.get(id)
        if (params.action === "pause" || params.action === "resume") {
          const definition = yield* automation.update(id, { paused: params.action === "pause" })
          if (definition.revision !== previous.revision) {
            yield* automation.publishDefinitionUpdated(definition)
          }
          return {
            title: params.action === "pause" ? "Automation paused" : "Automation resumed",
            metadata: { automationDefinition: definition },
            output: JSON.stringify(item(definition), null, 2),
          }
        }

        yield* ctx.ask({
          permission: "automate_manage",
          patterns: [id],
          always: [],
          metadata: { action: "delete", id, title: previous.title },
        })
        const removed = yield* automation.remove(id).pipe(Effect.mapError((error) => readableAutomationError(error, id)))
        yield* Effect.sync(() => scheduler.cancel(removed.tombstone.id))
        if (removed.stoppedRun) yield* automation.publishRunUpdated(removed.stoppedRun)
        yield* automation.publishDefinitionDeleted(removed.tombstone)
        return {
          title: "Automation deleted",
          metadata: { automationTombstone: removed.tombstone, stoppedRun: removed.stoppedRun },
          output: JSON.stringify(removed.tombstone, null, 2),
        }
      }),
  }
}

export const AutomateManageTool = Tool.define(
  "automate_manage",
  Effect.gen(function* () {
    const automation = yield* Automation.Service
    return createAutomateManageDefinition(automation)
  }),
)
