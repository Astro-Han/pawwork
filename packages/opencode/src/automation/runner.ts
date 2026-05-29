import { Effect } from "effect"
import { Automation } from "."
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { AutomationRunContext, type AutomationRunBlocker } from "./run-context"

export const sessionPromptExecutor: Automation.RunExecutor = async ({ definition, run, attendance, signal }) => {
  signal.throwIfAborted()
  const sessionID =
    definition.context === "continue" && definition.automationSessionID
      ? definition.automationSessionID
      : (await Session.create({ title: `Automation: ${definition.title}` })).id
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
