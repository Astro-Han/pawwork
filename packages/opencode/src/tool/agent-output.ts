import { Cause, Effect, Schema } from "effect"
import { NotFoundError } from "../storage/db"
import * as Tool from "./tool"
import { Session } from "../session"
import type { SessionID } from "../session/schema"
import { SubagentRun } from "../session/subagent-run"
import type { MessageV2 } from "../session/message-v2"

export const Parameters = Schema.Struct({
  subagent_session_id: Schema.optional(Schema.String),
  tool_call_id: Schema.optional(Schema.String),
  detail: Schema.Literals(["result", "transcript"]).pipe(
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed("result" as const)),
  ),
})

const formatResult = (p: MessageV2.SubtaskPart): string => {
  if (p.status === "running") {
    return [`status: running`, `summary: ${p.result_summary ?? "-"}`].join("\n")
  }
  if (p.status === "failed") {
    return [
      `status: failed`,
      `error.kind: ${p.error?.kind ?? "unknown"}`,
      `error.message: ${p.error?.message ?? ""}`,
    ].join("\n")
  }
  if (p.status === "canceled_by_user") {
    // Prefix with the terminal state so the model never mistakes a cancellation for a normal
    // completion. Body still surfaces partial output when the runner captured it.
    return [
      `status: canceled_by_user`,
      p.partial_result ? `partial_result:\n${p.partial_result}` : `(no partial output)`,
    ].join("\n")
  }
  if (p.status === "completed_empty") return "status: completed_empty\n(no output)"
  return p.result_text ?? p.partial_result ?? ""
}

const formatTranscript = (p: MessageV2.SubtaskPart): string => {
  const lines = [
    `status: ${p.status}`,
    `summary: ${p.result_summary ?? "-"}`,
    `events: ${p.recent_events.length}`,
    `child_session: ${p.subagent_session_id ?? "-"}`,
  ]
  // Mirror formatResult's fallback chain: prefer result_text, then partial_result, so
  // canceled_by_user rows still surface their preserved partial under detail=transcript.
  const body = p.result_text ?? p.partial_result ?? null
  if (body) {
    const trimmed =
      body.length > 1000
        ? `${body.slice(0, 1000)}…(truncated, ${body.length} chars total)`
        : body
    lines.push(`result: ${trimmed}`)
  }
  return lines.join("\n")
}

export const AgentOutputTool = Tool.define(
  "agent_output",
  Effect.gen(function* () {
    const subagentRun = yield* SubagentRun.Service
    const sessions = yield* Session.Service

    return {
      description:
        "Read a subagent's result or transcript preview. Pass exactly one of subagent_session_id or tool_call_id; reading a terminal row marks it consumed.",
      parameters: Parameters,
      execute: (
        params: {
          subagent_session_id?: string
          tool_call_id?: string
          detail: "result" | "transcript"
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          // XOR validation on subagent_session_id / tool_call_id. Schema-level filter is awkward
          // in Effect Schema 4 beta; doing it imperatively at the entry of execute keeps the
          // error message clear while still rejecting both-or-neither at runtime.
          if (Boolean(params.subagent_session_id) === Boolean(params.tool_call_id)) {
            return yield* Effect.fail(
              new Error("exactly one of subagent_session_id or tool_call_id is required"),
            )
          }
          // Narrow catch: only "row not found" maps to a clean not-found response. Storage errors,
          // schema decode failures, and other defects propagate via Effect.orDie so the model sees
          // a real defect instead of a misleading "not found".
          const row = params.tool_call_id
            ? yield* subagentRun
                .readByToolCallID(ctx.sessionID, params.tool_call_id)
                .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null as MessageV2.SubtaskPart | null)))
            : yield* subagentRun
                .findLatestBySessionID(ctx.sessionID, params.subagent_session_id! as SessionID)
                .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null as MessageV2.SubtaskPart | null)))
          if (!row || !row.tool_call_id)
            return yield* Effect.fail(new Error("subagent not found or not accessible from this parent"))
          if (row.parent_session_id !== ctx.sessionID)
            return yield* Effect.fail(new Error("subagent not found or not accessible from this parent"))
          if (row.subagent_session_id) {
            // session.get throws NotFoundError as a defect (Cause.Die). Suppress only that case;
            // re-raise any other defect (storage I/O, schema decode) so it isn't masked as a clean
            // not-found response.
            const child = yield* sessions
              .get(row.subagent_session_id as SessionID)
              .pipe(
                Effect.catchCause((cause) => {
                  const err = Cause.squash(cause)
                  return err instanceof NotFoundError
                    ? Effect.succeed(null)
                    : Effect.failCause(cause)
                }),
              )
            if (!child || !child.createdByAgentTool)
              return yield* Effect.fail(new Error("subagent not found or not accessible from this parent"))
          }
          if (row.status !== "running" && !row.consumed_at) {
            yield* subagentRun.setConsumed(row.tool_call_id)
          }
          const output = params.detail === "result" ? formatResult(row) : formatTranscript(row)
          return { title: "agent_output", metadata: { status: row.status }, output }
        }).pipe(Effect.orDie),
    }
  }),
)
