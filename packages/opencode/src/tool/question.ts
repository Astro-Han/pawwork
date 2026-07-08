import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import type { DecodeResult } from "./tool"
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

// Shape of the value the decoder produces on success — the route resolves
// the Deferred with this. Mirrors the legacy Question.Reply payload (now
// pre-validated so question.ts can use it as-is).
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

// Tool-owned decoder. Runs at the HTTP route before the Deferred is
// resolved — failure returns 422 to the client and leaves the entry
// pending so the client can correct and retry. Mirrors the legacy
// `Question.reply` checks at packages/opencode/src/question/index.ts:350-454.
// The 5th legacy check (duplicate option labels) runs in execute() before
// we ever register, because it's a self-check on the LLM's prompt — not
// on the user's submission.
export function questionDecoder(payload: unknown, snapshot: unknown): DecodeResult {
  const params = snapshot as Schema.Schema.Type<typeof Parameters> | null | undefined
  if (!params || !Array.isArray(params.questions)) {
    return { ok: false, error: "internal_snapshot_invalid" }
  }
  const questions = params.questions
  if (payload === null || typeof payload !== "object") {
    return { ok: false, error: "payload_not_object" }
  }
  const submitted = payload as { answers?: unknown }
  if (!Array.isArray(submitted.answers)) {
    return { ok: false, error: "answers_not_array" }
  }
  if (submitted.answers.length !== questions.length) {
    return {
      ok: false,
      error: "answer_count_mismatch",
      details: { expected: questions.length, got: submitted.answers.length },
    }
  }
  for (const row of submitted.answers) {
    if (!Array.isArray(row) || !row.every((s) => typeof s === "string")) {
      return { ok: false, error: "answer_row_not_string_array" }
    }
  }
  const trimmed: string[][] = (submitted.answers as ReadonlyArray<ReadonlyArray<string>>).map((row) =>
    row.map((s) => s.trim()).filter((s) => s.length > 0),
  )
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const answer = trimmed[i]!
    if (answer.length === 0) continue
    if (!q.multiple && answer.length > 1) {
      return {
        ok: false,
        error: "multi_answer_to_single_select",
        details: { index: i, answer },
      }
    }
    if (q.custom === false) {
      // Normalize both sides: answers were trimmed above, so option labels
      // must match. Otherwise an option declared as " yes " becomes "yes"
      // after decode and the membership check returns 422 forever.
      const validLabels = new Set(q.options.map((o) => o.label.trim()))
      for (const label of answer) {
        if (!validLabels.has(label)) {
          return {
            ok: false,
            error: "label_not_in_options",
            details: { index: i, label, validLabels: [...validLabels] },
          }
        }
      }
    }
  }
  const value: ExternalSubmitValue = { answers: trimmed }
  return { ok: true, value }
}

export const QuestionTool = Tool.define(
  "question",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // Declared statically so the renderer / dock can scope behavior to
      // tools that suspend on a user reply.
      externalResult: true,
      execute: Effect.fn("QuestionTool.execute")(function* (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context<Metadata>,
      ) {
        // Suspend on the external-result Deferred. The route runs
        // questionDecoder before resolving, so by the time we read
        // outcome.value the answers are already validated and shape-correct.
        // ExternalResultError (abort/shutdown) propagates as a typed failure
        // to the runner's writer; we do NOT catch it.
        //
        // Snapshot self-check: duplicate option labels are an LLM-prompt
        // bug, not a user-submission bug. The decoder cannot fix them.
        // Reject early so the route never registers a snapshot that
        // would later produce ambiguous answers.
        for (const q of params.questions) {
          const labels = q.options.map((o) => o.label.trim())
          if (new Set(labels).size !== labels.length) {
            return yield* Effect.die(
              new Error(
                `Question "${q.question}" has duplicate option labels (${labels.join(", ")}). Labels must be unique within a question.`,
              ),
            )
          }
        }
        const outcome = yield* ctx.externalResult!({ inputSnapshot: params, decoder: questionDecoder })
        if (outcome.kind === "dismissed") {
          return {
            title: "Question dismissed",
            output: "User dismissed the question.",
            metadata: { answers: [] as ReadonlyArray<Question.Answer>, dismissed: true },
          }
        }
        const submitted = outcome.value as ExternalSubmitValue
        const formatted = formatAnswers(params.questions, submitted.answers)
        return {
          title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
          output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
          metadata: { answers: submitted.answers, dismissed: false },
        }
      }),
    }
  }),
)
