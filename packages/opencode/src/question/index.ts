import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "@/session/schema"
import { Log } from "@opencode-ai/core/util/log"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { QuestionID } from "./schema"

export namespace Question {
  const log = Log.create({ service: "question" })

  // Schemas

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
      tooLongMsg:
        "Option label is too long (max 50 chars). Keep labels to 1–5 words; put detail in description.",
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
      tooLongMsg:
        "Header is too long (max 30 chars). Use a chip-sized label like 'Auth method' or 'Approach'.",
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

  export class Info extends Schema.Class<Info>("QuestionInfo")({
    ...base,
    custom: Schema.optional(Schema.Boolean).annotate({
      description: "Allow typing a custom answer (default: true)",
    }),
  }) {
    static readonly zod = zod(this)
  }

  // Prompt is the LLM-facing schema. Identical to Info — we expose `custom` so the
  // tool description's "Set false only when the options are exhaustive" instruction
  // is reachable from a real tool call.
  export class Prompt extends Schema.Class<Prompt>("QuestionPrompt")({
    ...base,
    custom: Schema.optional(Schema.Boolean).annotate({
      description: "Allow typing a custom answer (default: true)",
    }),
  }) {
    static readonly zod = zod(this)
  }

  export class Tool extends Schema.Class<Tool>("QuestionTool")({
    messageID: MessageID,
    callID: Schema.String,
  }) {
    static readonly zod = zod(this)
  }

  export class Request extends Schema.Class<Request>("QuestionRequest")({
    id: QuestionID,
    sessionID: SessionID,
    questions: Schema.mutable(Schema.Array(Info))
      .check(Schema.isMinLength(1, { message: "Provide at least one question." }))
      .check(
        Schema.isMaxLength(4, {
          message:
            "Ask at most 4 questions per invocation. If you have more, split into multiple tool calls or stream context first.",
        }),
      )
      .annotate({ description: "Questions to ask" }),
    tool: Schema.optional(Tool),
  }) {
    static readonly zod = zod(this)
  }

  export const Answer = Schema.Array(Schema.String)
    .annotate({ identifier: "QuestionAnswer" })
    .pipe(withStatics((s) => ({ zod: zod(s) })))
  export type Answer = Schema.Schema.Type<typeof Answer>

  export class Reply extends Schema.Class<Reply>("QuestionReply")({
    answers: Schema.Array(Answer).annotate({
      description: "User answers in order of questions (each answer is an array of selected labels)",
    }),
  }) {
    static readonly zod = zod(this)
  }

  class Replied extends Schema.Class<Replied>("QuestionReplied")({
    sessionID: SessionID,
    requestID: QuestionID,
    answers: Schema.Array(Answer),
  }) {
    static readonly zod = zod(this)
  }

  class Rejected extends Schema.Class<Rejected>("QuestionRejected")({
    sessionID: SessionID,
    requestID: QuestionID,
  }) {
    static readonly zod = zod(this)
  }

  export const Event = {
    Asked: BusEvent.define("question.asked", Request.zod),
    Replied: BusEvent.define("question.replied", Replied.zod),
    Rejected: BusEvent.define("question.rejected", Rejected.zod),
  }

  // `cancelled` distinguishes a session-cancel-driven rejection (signal abort
  // or fiber interrupt) from an intentional user dismissal. The processor
  // uses this to set metadata.interrupted only on cancel — a dismiss is a
  // completed user action, not an interruption. See #419.
  export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {
    cancelled: Schema.optional(Schema.Boolean),
  }) {
    override get message() {
      return "The user dismissed this question"
    }
  }

  interface PendingEntry {
    info: Request
    deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
  }

  interface State {
    pending: Map<QuestionID, PendingEntry>
  }

  // Service

  export interface Interface {
    readonly ask: (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
      // Production cancellation channel. EffectBridge.run.promise does not
      // propagate parent fiber interrupts, so without a signal a session
      // cancel leaks the pending entry and the dock stays forever. See #419.
      signal?: AbortSignal
    }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
    readonly reply: (input: { requestID: QuestionID; answers: ReadonlyArray<Answer> }) => Effect.Effect<void>
    readonly reject: (requestID: QuestionID) => Effect.Effect<void>
    readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const state = yield* InstanceState.make<State>(
        Effect.fn("Question.state")(function* () {
          const state = {
            pending: new Map<QuestionID, PendingEntry>(),
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const item of state.pending.values()) {
                yield* Deferred.fail(item.deferred, new RejectedError({ cancelled: true }))
              }
              state.pending.clear()
            }),
          )

          return state
        }),
      )

      const ask = Effect.fn("Question.ask")(function* (input: {
        sessionID: SessionID
        questions: ReadonlyArray<Info>
        tool?: Tool
        signal?: AbortSignal
      }) {
        // Replies are mapped back by label string, so duplicate labels within
        // a question would make answers ambiguous. Reject before publishing.
        // Compare trimmed labels because the schema's `TrimmedString` will
        // canonicalise " Yes " → "Yes" later — without trimming here, the
        // raw-label dup check would let two visually-distinct options collide
        // after decode and silently break reply()'s label→answer mapping.
        for (const q of input.questions) {
          const labels = q.options.map((o) => o.label.trim())
          if (new Set(labels).size !== labels.length) {
            return yield* Effect.die(
              new Error(
                `Question "${q.question}" has duplicate option labels (${labels.join(", ")}). Labels must be unique within a question.`,
              ),
            )
          }
        }

        const pending = (yield* InstanceState.get(state)).pending
        const id = QuestionID.ascending()
        log.info("asking", { id, questions: input.questions.length })

        const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
        const decoded = Schema.decodeUnknownSync(Request)({
          id,
          sessionID: input.sessionID,
          questions: input.questions,
          tool: input.tool,
        })
        // Snapshot once so the pending entry is decoupled from `input.questions`
        // (the Request schema marks `questions`/`options` as mutable arrays, and
        // bus subscribers + `list()` callers all hand out the same reference
        // otherwise). Without this, anyone holding a published `info` could
        // mutate `options.label` and silently break the reply() validation that
        // checks against the original prompt.
        const info = structuredClone(decoded)
        pending.set(id, { info, deferred })
        // Publish a fresh clone so subscribers can't reach back through the
        // event payload to mutate the pending entry either.
        yield* bus.publish(Event.Asked, structuredClone(info))

        // Cancellation: input.signal is the production channel; the
        // Effect.onInterrupt arm below is defence for direct fiber kill
        // (layer shutdown / supervisor) when signal is undefined. The abort
        // callback fires from the JS event loop, so we capture the parent
        // Effect context here and re-provide it on each runFork.
        const signal = input.signal
        let removeListener: (() => void) | undefined
        const sessionID = input.sessionID
        const ctx = yield* Effect.context<never>()
        const failFromAbort = InstanceState.bind(() => {
          const entry = pending.get(id)
          if (!entry) return
          pending.delete(id)
          log.info("rejected", { requestID: id, reason: "aborted" })
          Effect.runFork(
            Effect.provide(bus.publish(Event.Rejected, { sessionID, requestID: id }), ctx),
          )
          Effect.runFork(
            Effect.provide(Deferred.fail(entry.deferred, new RejectedError({ cancelled: true })), ctx),
          )
        })

        if (signal) {
          if (signal.aborted) {
            failFromAbort()
          } else {
            signal.addEventListener("abort", failFromAbort, { once: true })
            removeListener = () => signal.removeEventListener("abort", failFromAbort)
          }
        }

        return yield* Deferred.await(deferred).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!pending.has(id)) return
              pending.delete(id)
              log.info("rejected", { requestID: id, reason: "interrupted" })
              yield* bus.publish(Event.Rejected, { sessionID, requestID: id })
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (removeListener) removeListener()
              pending.delete(id)
            }),
          ),
        )
      })

      const reply = Effect.fn("Question.reply")(function* (input: {
        requestID: QuestionID
        answers: ReadonlyArray<Answer>
      }) {
        const pending = (yield* InstanceState.get(state)).pending
        const existing = pending.get(input.requestID)
        if (!existing) {
          log.warn("reply for unknown request", { requestID: input.requestID })
          return
        }

        // Validate the reply matches the pending question shape so a buggy
        // client cannot resolve the deferred with malformed answers (wrong
        // count, multi-select on single-select, or labels that were never
        // offered). Falling back to Deferred.fail keeps callers responsive.
        const questions = existing.info.questions
        if (input.answers.length !== questions.length) {
          log.warn("reply has wrong answer count", {
            requestID: input.requestID,
            expected: questions.length,
            got: input.answers.length,
          })
          pending.delete(input.requestID)
          yield* Deferred.fail(existing.deferred, new RejectedError())
          return
        }
        // Trim every answer string so " " / "\t" can't masquerade as a real
        // selection. The trimmed copy is what we validate AND what we resolve
        // the deferred with — otherwise membership/multi-select checks would
        // pass on the trimmed value but callers would still see the padded
        // original.
        const trimmedAnswers = input.answers.map((answer) => answer.map((label) => label.trim()))
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]!
          const rawAnswer = trimmedAnswers[i]!
          // Drop entries that became empty after trimming so [" "] and [""]
          // are treated as "no choice was made" instead of resolving with a
          // bogus blank selection.
          const answer = rawAnswer.filter((label) => label.length > 0)
          trimmedAnswers[i] = answer
          if (answer.length === 0) {
            log.info("skipped question answer", {
              requestID: input.requestID,
              index: i,
            })
            continue
          }
          if (!q.multiple && answer.length > 1) {
            log.warn("multiple answers to single-select question", {
              requestID: input.requestID,
              index: i,
              answer,
            })
            pending.delete(input.requestID)
            yield* Deferred.fail(existing.deferred, new RejectedError())
            return
          }
          const validLabels = new Set(q.options.map((o) => o.label))
          // `custom` defaults to true; only enforce label membership when the
          // question explicitly disallows custom answers.
          if (q.custom === false) {
            for (const label of answer) {
              if (!validLabels.has(label)) {
                log.warn("answer label not in question options", {
                  requestID: input.requestID,
                  index: i,
                  label,
                  validLabels: [...validLabels],
                })
                pending.delete(input.requestID)
                yield* Deferred.fail(existing.deferred, new RejectedError())
                return
              }
            }
          }
        }

        pending.delete(input.requestID)
        log.info("replied", { requestID: input.requestID, answers: trimmedAnswers })
        yield* bus.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          answers: trimmedAnswers.map((a) => [...a]),
        })
        yield* Deferred.succeed(existing.deferred, trimmedAnswers)
      })

      const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
        const pending = (yield* InstanceState.get(state)).pending
        const existing = pending.get(requestID)
        if (!existing) {
          log.warn("reject for unknown request", { requestID })
          return
        }
        pending.delete(requestID)
        log.info("rejected", { requestID })
        yield* bus.publish(Event.Rejected, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
        })
        yield* Deferred.fail(existing.deferred, new RejectedError())
      })

      const list = Effect.fn("Question.list")(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        // Hand callers a clone so they can't mutate the stored snapshot
        // (questions/options are typed as mutable arrays).
        return Array.from(pending.values(), (x) => structuredClone(x.info))
      })

      return Service.of({ ask, reply, reject, list })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
}
