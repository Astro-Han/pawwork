import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

const parameters = z.object({
  questions: z
    .array(Question.Prompt)
    .min(1, "Provide at least one question.")
    .max(4, "Ask at most 4 questions per invocation. If you have more, split into multiple tool calls or stream context first.")
    .describe("Questions to ask (1–4)"),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

// @ts-expect-error - Zod params accepted at runtime; Question.Prompt stays Zod-typed for PawWork's question namespace
export const QuestionTool = Tool.define<typeof parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
