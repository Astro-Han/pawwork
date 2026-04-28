import * as Tool from "./tool"
import DESCRIPTION from "./agent.txt"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { SubagentRun } from "../session/subagent-run"
import { Effect, Schema } from "effect"

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

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

const truncateHead = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n))

// Stub replaced in Task 10. Reads the last completed assistant text from the child session
// (used for partial_result on cancel). Returns null when no completed text exists.
const readLastCompletedAssistantText = (_sessionID: SessionID): Effect.Effect<string | null> =>
  Effect.succeed(null)

// Stub replaced in Task 10. Renders the SubtaskPart into the tool's text output.
const synthesizeOutput = (
  part: MessageV2.SubtaskPart,
  childID: SessionID | undefined,
): {
  title: string
  metadata: { sessionId: SessionID | undefined; status: MessageV2.SubtaskPart["status"] }
  output: string
} => {
  const lines: string[] = []
  if (part.status !== "completed") {
    lines.push(`status: ${part.status}`)
    if (part.error) lines.push(`error: ${part.error.kind}`)
    lines.push("")
  }
  if (childID) {
    lines.push(`subagent_session_id: ${childID} (pass this to resume the same subagent dispatch)`)
    lines.push("")
  }
  lines.push("<subagent_result>")
  lines.push(part.result_text ?? part.partial_result ?? "")
  lines.push("</subagent_result>")
  return {
    title: part.description,
    metadata: {
      sessionId: childID,
      status: part.status,
    },
    output: lines.join("\n"),
  }
}

export const AgentTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const subagentRun = yield* SubagentRun.Service

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

      const canAgent = next.permission.some((rule) => rule.permission === id)
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
      const session = params.subagent_session_id
        ? yield* sessions.get(SessionID.make(params.subagent_session_id)).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
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
          subagent_type: params.subagent_type,
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
              subagent_type: params.subagent_type,
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
                  ...(canTodo
                    ? []
                    : [
                        {
                          permission: "todowrite" as const,
                          pattern: "*" as const,
                          action: "deny" as const,
                        },
                      ]),
                  ...(canAgent
                    ? []
                    : [
                        {
                          permission: id,
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

            // Idempotent finalizer: latches `interrupted` synchronously at handler entry so a
            // late parent abort during cleanup of a real model failure cannot misclassify it.
            const finalizeAfter = (
              result: { kind: "ok"; r: MessageV2.WithParts } | { kind: "err"; error: unknown },
            ) =>
              Effect.gen(function* () {
                const interrupted = ops.wasInterrupted(nextSession.id) || ctx.abort.aborted
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
                Effect.tap((r) => finalizeAfter({ kind: "ok", r })),
                Effect.catch((error) => finalizeAfter({ kind: "err", error })),
              )

            const finalPart = yield* subagentRun.read(ctx.callID!)
            return synthesizeOutput(finalPart, nextSession.id)
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const current = yield* subagentRun
                  .read(ctx.callID!)
                  .pipe(Effect.catch(() => Effect.succeed(null as MessageV2.SubtaskPart | null)))
                if (current?.status === "running") {
                  yield* subagentRun.finalize(ctx.callID!, "failed", {
                    error: { kind: "execution_error", message: errorMessage(error) },
                    ended_at: Date.now(),
                  })
                }
                return yield* Effect.fail(error)
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
