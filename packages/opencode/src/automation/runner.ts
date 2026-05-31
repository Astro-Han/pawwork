import { Effect } from "effect"
import { Automation } from "."
import { AutomationRunTable } from "./automation.sql"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Database, and, eq, sql } from "@/storage/db"
import { AutomationRunContext, type AutomationRunBlocker } from "./run-context"
import { Worktree } from "@/worktree"

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
    const binding = await Session.findActiveWorktreeBinding(directory)
    if (!binding) return
    if (!isAutomationOwnedSession(binding.id)) return
    await Session.updateExecutionContext({ sessionID: binding.id, activeWorktree: null })
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

export const sessionPromptExecutor: Automation.RunExecutor = async ({ definition, run, attendance, signal }) => {
  signal.throwIfAborted()
  const worktree = await prepareWorktreePlacement(definition)
  signal.throwIfAborted()
  const sessionID =
    definition.context === "continue" && definition.automationSessionID
      ? definition.automationSessionID
      : (await Session.create({ title: `Automation: ${definition.title}` })).id
  if (worktree) {
    await Session.updateExecutionContext({
      sessionID,
      activeWorktree: {
        directory: worktree.directory,
        name: worktree.name,
        branch: worktree.branch,
        source: worktree.source,
      },
    })
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
