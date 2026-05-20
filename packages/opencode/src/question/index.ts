import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export namespace Question {
  // PawWork-specific length/trim guards: keep label/description/header/question
  // bounded so chips and prompts render well, and so models can't smuggle empty
  // strings through whitespace padding. The hint wording is contracted with
  // tests so the LLM-facing error guidance stays stable across refactors.
  const TrimmedString = (max: number, opts: { emptyMsg: string; tooLongMsg: string }) =>
    Schema.Trim.pipe(
      Schema.check(Schema.isMinLength(1, { message: opts.emptyMsg })),
      Schema.check(Schema.isMaxLength(max, { message: opts.tooLongMsg })),
    )

  export class Option extends Schema.Class<Option>("QuestionOption")({
    label: TrimmedString(50, {
      emptyMsg: "Option label cannot be empty.",
      tooLongMsg: "Option label is too long (max 50 chars). Keep labels to 1–5 words; put detail in description.",
    }).annotate({ description: "Display text (1–5 words, max 50 chars)" }),
    description: TrimmedString(50, {
      emptyMsg: "Option description cannot be empty.",
      tooLongMsg:
        "Option description is too long (max 50 chars). Keep it to one line; longer trade-off context belongs in the question or in normal streamed output before the tool call.",
    }).annotate({ description: "One-line explanation of choice (max 50 chars)" }),
  }) {
    static readonly zod = zod(this)
  }

  const base = {
    question: TrimmedString(200, {
      emptyMsg: "Question cannot be empty.",
      tooLongMsg:
        "Question is too long (max 200 chars). Stream longer framing or trade-off context as normal assistant output before invoking this tool, then keep the question short.",
    }).annotate({
      description: "Short question (max 200 chars). Stream longer framing as normal output first.",
    }),
    header: TrimmedString(30, {
      emptyMsg: "Header cannot be empty.",
      tooLongMsg: "Header is too long (max 30 chars). Use a chip-sized label like 'Auth method' or 'Approach'.",
    }).annotate({ description: "Very short label (max 30 chars)" }),
    options: Schema.mutable(Schema.Array(Option))
      .check(Schema.isMinLength(2, { message: "Each question needs at least 2 options." }))
      .check(
        Schema.isMaxLength(4, {
          message: "Each question allows at most 4 options. Keep choices distinct and mutually exclusive.",
        }),
      )
      .annotate({ description: "Available choices (2–4)" }),
    multiple: Schema.optional(Schema.Boolean).annotate({
      description: "Allow selecting multiple choices",
    }),
  }

  // Prompt is the LLM-facing schema exposed to tool/question.ts and the
  // external-result decoder. Keep `custom` so the tool description's
  // "Set false only when the options are exhaustive" instruction is reachable.
  export class Prompt extends Schema.Class<Prompt>("QuestionPrompt")({
    ...base,
    custom: Schema.optional(Schema.Boolean).annotate({
      description: "Allow typing a custom answer (default: true)",
    }),
  }) {
    static readonly zod = zod(this)
  }

  export const Answer = Schema.Array(Schema.String)
    .annotate({ identifier: "QuestionAnswer" })
    .pipe(withStatics((s) => ({ zod: zod(s) })))
  export type Answer = Schema.Schema.Type<typeof Answer>
}
