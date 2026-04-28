import * as Tool from "./tool"
import DESCRIPTION from "./agent.txt"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { SubagentRun } from "../session/subagent-run"
import { Cause, Effect, Schema } from "effect"
import { NotFoundError } from "../storage/db"

export interface AgentPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  /**
   * After ops.prompt resolves, returns true iff the child session's runner.onInterrupt
   * fired during execution (parent abort propagated through `cancel()`, OR a user
   * canceled the child session directly). Returns false on natural completion or model
   * failure. Synchronous query.
   */
  wasInterrupted(sessionID: SessionID): boolean
}

const id = "agent"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the subagent dispatch" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized subagent to use for this dispatch" }),
  subagent_session_id: Schema.optional(Schema.String).annotate({
    description:
      "Set only when resuming a prior subagent dispatch — pass the prior subagent_session_id and the subagent will continue its previous session instead of starting a fresh one.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this dispatch" }),
})

const truncateHead = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…")

const SANITIZE_LIMIT = 200
const STACK_RE = /\n\s+at\s+.+/g
// Covers POSIX home paths (/Users/..., /home/...), Windows drive paths (C:\Users\...,
// D:\projects\...), and UNC paths (\\server\share\...). All collapse to "<path>" so usernames
// and local layout never leak into persisted SubtaskPart.error.message.
const PATH_RE = /(?:\/(?:Users|home)\/[^\s)]+|[A-Za-z]:\\[^\s)]+|\\\\[^\s)]+)/g
// Non-greedy JSON match so legitimate prose containing braces (e.g., a sanitized status header
// quoted in an error message) is not stripped wholesale. Matches one envelope at a time.
const JSON_ENVELOPE_RE = /\{[\s\S]+?\}/g

export const sanitizeErrorMessage = (msg: string): string =>
  msg
    .replace(STACK_RE, "")
    .replace(PATH_RE, "<path>")
    .replace(JSON_ENVELOPE_RE, "<json>")
    .slice(0, SANITIZE_LIMIT)
    .trim()

// Sanitizes at the entry point so persisted SubtaskPart.error.message never contains raw stacks,
// paths, or JSON envelopes — agent_output reads this field directly without re-sanitizing.
const errorMessage = (e: unknown): string => {
  const raw =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : (() => {
            try {
              return JSON.stringify(e)
            } catch {
              return String(e)
            }
          })()
  return sanitizeErrorMessage(raw)
}

// TextPart in message-v2.ts has no explicit state field; completion is signaled by `time.end`.
// Conservative default: returns false when `time` or `time.end` is missing → partial_result
// stays null on mid-token streaming aborts, which is safer than leaking a half-token.
const isTextPartCompleted = (p: MessageV2.TextPart): boolean => p.time?.end !== undefined

// Reads the child session's most recent assistant text part with stable (completed) content.
// Used by finalizeAfter for partial_result on cancellation; returns null when no completed text
// exists (e.g., cancellation during the first tool call or mid-token streaming abort).
//
// Scans the full message history rather than a fixed window: tool-heavy children can push the
// last completed assistant text past any short backscan, and cancellation is a rare path so the
// extra read cost is acceptable.
const makeReadLastCompletedAssistantText =
  (sessions: Session.Service["Service"]) =>
  (childID: SessionID): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const messages = yield* sessions.messages({ sessionID: childID })
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.info.role !== "assistant") continue
        const textParts = m.parts.filter((p): p is MessageV2.TextPart => p.type === "text")
        const completed = textParts.findLast((p) => isTextPartCompleted(p))
        if (completed?.text && completed.text.trim().length > 0) return completed.text
      }
      return null
    })

const synthesizeOutput = (
  part: MessageV2.SubtaskPart,
  childID: SessionID | undefined,
): {
  title: string
  metadata: { sessionId: SessionID | undefined; status: MessageV2.SubtaskPart["status"] }
  output: string
} => {
  const resumeHint = childID
    ? `subagent_session_id: ${childID} (pass this to resume the same subagent dispatch)`
    : null
  const wrapper = (text: string) => `<subagent_result>\n${text}\n</subagent_result>`

  if (part.status === "completed") {
    // PRESERVE the EXACT 5-line success format from the original tool: resume hint, blank,
    // open tag, text, close tag. Existing prompt teaching depends on this shape.
    return {
      title: part.description,
      metadata: { sessionId: childID, status: part.status },
      output: [
        resumeHint,
        "",
        "<subagent_result>",
        part.result_text ?? "",
        "</subagent_result>",
      ]
        .filter((x): x is string => x !== null)
        .join("\n"),
    }
  }

  let header: string
  let body: string
  switch (part.status) {
    case "completed_empty":
      header = "status: completed_empty"
      body = wrapper("")
      break
    case "canceled_by_user":
      header = "status: canceled_by_user"
      body = wrapper(part.partial_result ?? "")
      break
    case "failed":
      header = `status: failed\nerror: ${sanitizeErrorMessage(part.error?.message ?? "")}`
      body = wrapper("")
      break
    case "running":
      // Defensive: should never be returned to the model since execute waits for terminal state.
      header = "status: running"
      body = wrapper("")
      break
  }

  return {
    title: part.description,
    metadata: { sessionId: childID, status: part.status },
    output: [resumeHint, "", header, body]
      .filter((x): x is string => x !== null)
      .join("\n"),
  }
}

export const AgentTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const subagentRun = yield* SubagentRun.Service
    const readLastCompletedAssistantText = makeReadLastCompletedAssistantText(sessions)

    const run = Effect.fn("AgentTool.execute")(function* (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()

      if (!ctx.callID) return yield* Effect.fail(new Error("AgentTool.execute requires ctx.callID"))

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const ops = ctx.extra?.promptOps as AgentPromptOps
      if (!ops) return yield* Effect.fail(new Error("AgentTool requires promptOps in ctx.extra"))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      // Validate the SessionID shape up front so a typo in subagent_session_id surfaces a clear
      // error instead of silently falling through to "create a fresh session", which would lose
      // the user's intent to resume. Pulled forward from upstream's pre-refactor agent.ts.
      if (params.subagent_session_id !== undefined) {
        const exit = Schema.decodeUnknownExit(SessionID)(params.subagent_session_id)
        if (exit._tag === "Failure") {
          return yield* Effect.fail(
            new Error(
              `Invalid subagent_session_id: ${JSON.stringify(params.subagent_session_id)}. Pass a previously emitted subagent_session_id to resume, or omit the field to start a fresh dispatch.`,
            ),
          )
        }
      }
      // sessions.get throws NotFoundError as a defect (Cause.Die). Suppress only that case so the
      // resume path can fall through to "subagent_session_id not found"; rethrow any other defect
      // (storage I/O, schema decode) instead of masking it as missing.
      const session = params.subagent_session_id
        ? yield* sessions.get(SessionID.make(params.subagent_session_id)).pipe(
            Effect.catchCause((cause) => {
              const err = Cause.squash(cause)
              return err instanceof NotFoundError ? Effect.succeed(undefined) : Effect.failCause(cause)
            }),
          )
        : undefined
      if (params.subagent_session_id && !session) {
        return yield* Effect.fail(new Error("subagent_session_id not found"))
      }
      if (session) {
        if (session.parentID !== ctx.sessionID) {
          return yield* Effect.fail(new Error("subagent does not belong to this parent"))
        }
        if (!session.createdByAgentTool) {
          return yield* Effect.fail(new Error("subagent was not created by the agent tool"))
        }
        if (session.subagentType !== params.subagent_type) {
          return yield* Effect.fail(new Error("subagent_type does not match"))
        }
      }

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      // Cap-rejection check happens before any slot is reserved or expensive work begins.
      // The TooManyActive failure is mapped to a synthesized status: failed output instead.
      const reserveResult = yield* subagentRun.reserveSlot(ctx.sessionID).pipe(
        Effect.catchTag("TooManyActive", () => Effect.succeed("rejected" as const)),
      )
      if (reserveResult === "rejected") {
        const rejected = yield* subagentRun.recordRejected({
          parent_session_id: ctx.sessionID,
          parent_message_id: ctx.messageID,
          tool_call_id: ctx.callID,
          description: params.description,
          prompt: params.prompt,
          agent: next.name,
          command: params.command,
          model,
          reason:
            "This is a limit, not a failure. Wait for an existing subagent to complete, or reduce the dispatch.",
        })
        return synthesizeOutput(rejected, undefined)
      }

      // Slot reserved. Effect.scoped wraps the rest so:
      //   - releaseSlot fires on every exit path (success, error, defect, fiber interrupt)
      //   - listener cleanup fires on every exit path
      //   - SubtaskPart row never gets stranded in `running`: outer catchAll finalizes if any
      //     pre-prompt step throws between `start` and `ops.prompt`.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => subagentRun.releaseSlot(ctx.sessionID))

          return yield* Effect.gen(function* () {
            yield* subagentRun.start({
              parent_session_id: ctx.sessionID,
              parent_message_id: ctx.messageID,
              tool_call_id: ctx.callID!,
              description: params.description,
              prompt: params.prompt,
              agent: next.name,
              command: params.command,
              model,
            })

            const nextSession =
              session ??
              (yield* sessions.create({
                parentID: ctx.sessionID,
                title: params.description + ` (@${next.name} subagent)`,
                createdByAgentTool: true,
                subagentType: params.subagent_type,
                permission: [
                  // v1 nested-deny: agent is denied unconditionally so a subagent cannot
                  // recursively dispatch its own subagents (#283 non-goal: nested subagents).
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                  ...(canTodo
                    ? []
                    : [
                        {
                          permission: "todowrite" as const,
                          pattern: "*" as const,
                          action: "deny" as const,
                        },
                      ]),
                  ...(cfg.experimental?.primary_tools?.map((item) => ({
                    pattern: "*",
                    action: "allow" as const,
                    permission: item,
                  })) ?? []),
                ],
              }))

            yield* subagentRun.patchSession(ctx.callID!, nextSession.id)

            yield* ctx.metadata({
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
            })

            const onParentAbort = () => ops.cancel(nextSession.id)
            ctx.abort.addEventListener("abort", onParentAbort)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => ctx.abort.removeEventListener("abort", onParentAbort)),
            )

            // Pre-aborted short-circuit. If parent already aborted before we got here, skip
            // ops.prompt entirely and finalize as canceled_by_user with no partial_result.
            if (ctx.abort.aborted) {
              yield* subagentRun.finalize(ctx.callID!, "canceled_by_user", {
                partial_result: null,
                ended_at: Date.now(),
              })
              const part = yield* subagentRun.read(ctx.callID!)
              return synthesizeOutput(part, nextSession.id)
            }

            // Idempotent finalizer. `wasInterrupted` is the source of truth for cancellation;
            // do not OR with `ctx.abort.aborted` (it can flip after natural success and relabel
            // completed runs as canceled).
            const finalizeAfter = (
              result: { kind: "ok"; r: MessageV2.WithParts } | { kind: "err"; error: unknown },
            ) =>
              Effect.gen(function* () {
                const interrupted = ops.wasInterrupted(nextSession.id)
                const current = yield* subagentRun.read(ctx.callID!)
                if (current.status !== "running") return
                if (interrupted) {
                  const partial = yield* readLastCompletedAssistantText(nextSession.id)
                  yield* subagentRun.finalize(ctx.callID!, "canceled_by_user", {
                    partial_result: partial,
                    ended_at: Date.now(),
                  })
                  return
                }
                if (result.kind === "err") {
                  yield* subagentRun.finalize(ctx.callID!, "failed", {
                    error: { kind: "execution_error", message: errorMessage(result.error) },
                    ended_at: Date.now(),
                  })
                  return
                }
                const lastText = result.r.parts.findLast((p) => p.type === "text")?.text ?? ""
                if (lastText.trim().length === 0) {
                  yield* subagentRun.finalize(ctx.callID!, "completed_empty", {
                    ended_at: Date.now(),
                  })
                } else {
                  yield* subagentRun.finalize(ctx.callID!, "completed", {
                    result_text: lastText,
                    result_summary: truncateHead(lastText, 300),
                    ended_at: Date.now(),
                  })
                }
              })

            // Explicit success / failure dispatch so each path runs its matching finalize
            // exactly once and bugs don't get reclassified across paths:
            //  - success: ok-finalize runs; if it fails, the failure propagates so the outer
            //    catchCause sees the storage error instead of read() returning a stale "running"
            //    row that synthesizeOutput would render as a defective success.
            //  - failure: err-finalize runs (best-effort row cleanup), then the original cause
            //    re-raises via failCause so stack/annotations survive.
            const parts = yield* ops.resolvePromptParts(params.prompt)
            yield* ops
              .prompt({
                messageID: MessageID.ascending(),
                sessionID: nextSession.id,
                model: { modelID: model.modelID, providerID: model.providerID },
                agent: next.name,
                tools: {
                  agent: false,
                  ...(canTodo ? {} : { todowrite: false }),
                  ...Object.fromEntries(
                    (cfg.experimental?.primary_tools ?? []).map((item) => [item, false]),
                  ),
                },
                parts,
              })
              .pipe(
                Effect.matchCauseEffect({
                  onSuccess: (r) => finalizeAfter({ kind: "ok", r }),
                  onFailure: (cause) =>
                    Effect.gen(function* () {
                      yield* finalizeAfter({ kind: "err", error: Cause.squash(cause) }).pipe(
                        Effect.catchCause(() => Effect.void),
                      )
                      return yield* Effect.failCause(cause)
                    }),
                }),
              )

            const finalPart = yield* subagentRun.read(ctx.callID!)
            return synthesizeOutput(finalPart, nextSession.id)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const current = yield* subagentRun
                  .read(ctx.callID!)
                  .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null as MessageV2.SubtaskPart | null)))
                if (current?.status === "running") {
                  yield* subagentRun.finalize(ctx.callID!, "failed", {
                    error: { kind: "execution_error", message: errorMessage(Cause.squash(cause)) },
                    ended_at: Date.now(),
                  })
                }
                // Re-fail with the original cause so stack, annotations, and parallel-error
                // metadata are preserved instead of getting flattened into Effect.fail.
                // ctx.metadata (set in step 4) keeps subagent_session_id visible to the parent
                // for resume even when the tool result lands as `error`.
                return yield* Effect.failCause(cause)
              }),
            ),
          )
        }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
