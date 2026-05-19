import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Flag } from "@opencode-ai/core/flag/flag"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt))
    .check(Schema.isMinLength(1, { message: "Provide at least one question." }))
    .check(
      Schema.isMaxLength(4, {
        message:
          "Ask at most 4 questions per invocation. If you have more, split into multiple tool calls or stream context first.",
      }),
    )
    .annotate({ description: "Questions to ask (1–4)" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  dismissed?: boolean
}

// Shape of the value the route resolves the Deferred with on submit.
// Mirrors the legacy Question.Reply payload — the route forwards
// validated answers as-is.
type ExternalSubmitValue = {
  answers: ReadonlyArray<ReadonlyArray<string>>
}

function formatAnswers(
  questions: Schema.Schema.Type<typeof Parameters>["questions"],
  answers: ReadonlyArray<ReadonlyArray<string>>,
) {
  return questions
    .map((q, i) => {
      const answer = answers[i] ?? []
      return `"${q.question}"="${answer.length ? answer.join(", ") : "Skipped by user"}"`
    })
    .join(", ")
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // Declared statically so the renderer / dock can scope behavior to
      // tools that suspend on a user reply. The actual flag-on branch is
      // selected per-execute via PAWWORK_QUESTION_TOOL_EXTERNAL_RESULT.
      externalResult: true,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (Flag.PAWWORK_QUESTION_TOOL_EXTERNAL_RESULT && ctx.externalResult) {
            // Flag-on path: suspend on the external-result Deferred. The
            // route resolves with a discriminated union we narrow here.
            // ExternalResultError (abort/shutdown) propagates as a typed
            // failure to the runner's writer; we do NOT catch it.
            const outcome = yield* ctx.externalResult({ inputSnapshot: params })
            if (outcome.kind === "dismissed") {
              return {
                title: "Question dismissed",
                output: "User dismissed the question.",
                metadata: { answers: [], dismissed: true },
              }
            }
            const submitted = outcome.value as ExternalSubmitValue
            const answers = submitted.answers
            const formatted = formatAnswers(params.questions, answers)
            return {
              title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
              output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
              metadata: { answers },
            }
          }

          // Legacy path (flag off). Bit-for-bit identical to pre-PR-A.
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            // ctx.abort is the only signal that survives the EffectBridge
            // promise wrapper around tool execution. See Question.ask doc.
            signal: ctx.abort,
          })

          const formatted = formatAnswers(params.questions, answers)

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: { answers },
          }
        }),
    }
  }),
)
