import { Effect } from "effect"
import { Automation } from "."
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { AutomationRunContext } from "./run-context"

export const sessionPromptExecutor: Automation.RunExecutor = async ({ definition, run, attendance, signal }) => {
  const sessionID =
    definition.context === "continue" && definition.automationSessionID
      ? definition.automationSessionID
      : (await Session.create({ title: `Automation: ${definition.title}` })).id
  let currentRun = Automation.markRunStarted(run, sessionID)
  await Automation.publishRunUpdated(currentRun)
  const context = AutomationRunContext.attended({
    stepCap: 50,
    block: (blocker) =>
      Effect.sync(() => {
        currentRun = Automation.markRunBlocked(currentRun, blocker)
      }).pipe(Effect.flatMap(() => Effect.promise(() => Automation.publishRunUpdated(currentRun)))),
    clear: () =>
      Effect.sync(() => {
        currentRun = Automation.clearRunBlocker(currentRun)
      }).pipe(Effect.flatMap(() => Effect.promise(() => Automation.publishRunUpdated(currentRun)))),
  })
  const scoped = attendance === "attended" ? context : AutomationRunContext.unattended(context)
  const message = await SessionPrompt.promptWithAutomationContext(
    {
      sessionID,
      parts: [{ type: "text", text: definition.prompt }],
    },
    scoped,
  )
  signal.throwIfAborted()
  return {
    sessionID,
    result: message.parts.find((part) => part.type === "text")?.text ?? null,
    cost: message.info.role === "assistant" ? message.info.cost : null,
  }
}
