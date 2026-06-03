import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import type { DecodeResult } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

function getLastModel(sessionID: SessionID) {
  for (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

export const Parameters = Schema.Struct({})

// Question-shaped input snapshot the dock renders against. The PlanExitTool
// reuses the question dock by emitting questions in the same shape; the
// running tool part's metadata.externalResultReady tells the renderer to
// render this tool's external-result prompt.
type PlanExitSnapshot = {
  questions: ReadonlyArray<Schema.Schema.Type<typeof Question.Prompt>>
}

function planExitDecoder(payload: unknown, snapshot: unknown): DecodeResult {
  const params = snapshot as PlanExitSnapshot | null | undefined
  if (!params || !Array.isArray(params.questions)) {
    return { ok: false, error: "internal_snapshot_invalid" }
  }
  if (payload === null || typeof payload !== "object") {
    return { ok: false, error: "payload_not_object" }
  }
  const submitted = payload as { answers?: unknown }
  if (!Array.isArray(submitted.answers)) {
    return { ok: false, error: "answers_not_array" }
  }
  if (submitted.answers.length !== params.questions.length) {
    return { ok: false, error: "answer_count_mismatch" }
  }
  for (const row of submitted.answers) {
    if (!Array.isArray(row) || !row.every((s) => typeof s === "string")) {
      return { ok: false, error: "answer_row_not_string_array" }
    }
  }
  const trimmed: string[][] = (submitted.answers as ReadonlyArray<ReadonlyArray<string>>).map((row) =>
    row.map((s) => s.trim()).filter((s) => s.length > 0),
  )
  const validLabels = new Set(params.questions[0]!.options.map((o: { label: string }) => o.label.trim()))
  for (const label of trimmed[0] ?? []) {
    if (!validLabels.has(label)) {
      return { ok: false, error: "label_not_in_options" }
    }
  }
  return { ok: true, value: { answers: trimmed } }
}

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      externalResult: true,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(Instance.worktree, Session.plan(info))
          const snapshot: PlanExitSnapshot = {
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and implement the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              } as Schema.Schema.Type<typeof Question.Prompt>,
            ],
          }
          const outcome = yield* ctx.externalResult!({ inputSnapshot: snapshot, decoder: planExitDecoder })
          if (outcome.kind === "dismissed") {
            return {
              title: "Plan exit dismissed",
              output: "User dismissed the plan exit prompt.",
              metadata: {},
            }
          }
          const value = outcome.value as { answers: string[][] }
          if (value.answers[0]?.[0] !== "Yes") {
            return {
              title: "Staying in plan mode",
              output: "User declined to switch to the build agent.",
              metadata: {},
            }
          }

          const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel().pipe(Effect.orDie))

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }),
    }
  }),
)
