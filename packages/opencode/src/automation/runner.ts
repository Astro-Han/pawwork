import { Effect } from "effect"
import { Log } from "@opencode-ai/core/util/log"
import { Automation } from "."
import { AutomationRunTable } from "./automation.sql"
import { AppRuntime } from "@/effect/app-runtime"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Database, NotFoundError, and, eq, sql } from "@/storage/db"
import { AutomationRunContext, type AutomationRunBlocker } from "./run-context"
import { Worktree } from "@/worktree"

const log = Log.create({ service: "automation.runner" })

function isAutomationOwnedSession(sessionID: string) {
  return Boolean(
    Database.use((db) =>
      db
        .select({ id: AutomationRunTable.id })
        .from(AutomationRunTable)
        .where(
          and(
            eq(AutomationRunTable.project_id, Instance.project.id),
            eq(AutomationRunTable.owner_directory, Instance.directory),
            sql`json_extract(${AutomationRunTable.data}, '$.sessionID') = ${sessionID}`,
          ),
        )
        .limit(1)
        .get(),
    ),
  )
}

async function releaseAutomationWorktreeBindings(directory: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const binding = await AppRuntime.runPromise(Session.Service.use((svc) => svc.findActiveWorktreeBinding(directory)))
    if (!binding) return
    if (!isAutomationOwnedSession(binding.id)) return
    await AppRuntime.runPromise(
      Session.Service.use((svc) => svc.updateExecutionContext({ sessionID: binding.id, activeWorktree: null })),
    )
  }
}

async function prepareWorktreePlacement(definition: Automation.Definition) {
  const placement = definition.where.worktree
  if (!placement) return undefined
  const existing = await Worktree.lookupBySlug(placement)
  if (existing) {
    await releaseAutomationWorktreeBindings(existing.directory)
    await Worktree.reset({ directory: existing.directory })
    return (await Worktree.lookupBySlug(placement)) ?? existing
  }
  return Worktree.createReady({ name: placement, exactName: true })
}

// Continue automations append to the conversation they were created in; fresh
// automations get their own session per run. If a continue automation's source
// conversation is gone (the user deleted it, or it was never recorded), fail
// loudly instead of silently spawning a detached session the user can't find —
// the old "mystery new session" behaviour. Only a genuine NotFound counts as
// "gone": a DB or decode fault must surface its real error, not be mislabelled
// as a missing conversation.
async function resolveRunSession(definition: Automation.Definition) {
  if (definition.context === "continue") {
    const sourceSessionID = definition.sourceSessionID
    const source = sourceSessionID
      ? await AppRuntime.runPromise(Session.Service.use((svc) => svc.get(sourceSessionID))).catch((error) => {
          if (NotFoundError.isInstance(error)) return undefined
          // A real DB/decode fault, not a deleted source. The run still ends as
          // a silent cancel downstream, so leave a trail here or the fault is
          // invisible to anyone debugging it.
          log.error("automation continue source lookup failed", {
            error,
            automationID: definition.id,
            sourceSessionID,
          })
          throw error
        })
      : undefined
    if (!source) {
      throw new Error(`automation "${definition.title}" continues a conversation that no longer exists`)
    }
    return source.id
  }
  return (
    await AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: `Automation: ${definition.title}` })))
  ).id
}

export const sessionPromptExecutor: Automation.RunExecutor = async ({ definition, run, attendance, signal }) => {
  signal.throwIfAborted()
  const worktree = await prepareWorktreePlacement(definition)
  signal.throwIfAborted()
  const sessionID = await resolveRunSession(definition)
  if (worktree) {
    await AppRuntime.runPromise(
      Session.Service.use((svc) =>
        svc.updateExecutionContext({
          sessionID,
          activeWorktree: {
            directory: worktree.directory,
            name: worktree.name,
            branch: worktree.branch,
            source: worktree.source,
          },
        }),
      ),
    )
  }
  const cancelPrompt = () => {
    void SessionPrompt.cancel(sessionID, { source: "automation.cancel" }).catch(() => undefined)
  }
  if (signal.aborted) cancelPrompt()
  else signal.addEventListener("abort", cancelPrompt, { once: true })
  try {
    signal.throwIfAborted()
    let currentRun = Automation.markRunStarted(run, sessionID)
    await Automation.publishRunUpdated(currentRun)
    const handlers = {
      stepCap: 50,
      block: (blocker: AutomationRunBlocker) =>
        Effect.gen(function* () {
          const previous = currentRun
          currentRun = Automation.markRunBlocked(currentRun, blocker)
          if (currentRun !== previous) yield* Effect.promise(() => Automation.publishRunUpdated(currentRun))
        }),
      clear: () =>
        Effect.gen(function* () {
          const previous = currentRun
          currentRun = Automation.clearRunBlocker(currentRun)
          if (currentRun !== previous) yield* Effect.promise(() => Automation.publishRunUpdated(currentRun))
        }),
    }
    const scoped =
      attendance === "attended" ? AutomationRunContext.attended(handlers) : AutomationRunContext.unattended(handlers)
    const message = await SessionPrompt.promptWithAutomationContext(
      {
        sessionID,
        automationID: definition.id,
        model: definition.model,
        ...(definition.variant ? { variant: definition.variant } : {}),
        parts: [{ type: "text", text: definition.prompt }],
      },
      scoped,
      { abortSignal: signal },
    )
    signal.throwIfAborted()
    return {
      sessionID,
      result: message.parts.find((part) => part.type === "text")?.text ?? null,
      cost: message.info.role === "assistant" ? message.info.cost : null,
    }
  } finally {
    signal.removeEventListener("abort", cancelPrompt)
  }
}
