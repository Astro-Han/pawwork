import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Session } from "../session"
import type { SessionID } from "../session/schema"
import { SubagentRun } from "../session/subagent-run"
import type { MessageV2 } from "../session/message-v2"

const formatResult = (p: MessageV2.SubtaskPart): string => {
  if (p.status === "running") {
    return [`status: running`, `latest: ${p.last_activity?.label ?? "-"}`].join("\n")
  }
  if (p.status === "failed") {
    return [
      `status: failed`,
      `error.kind: ${p.error?.kind ?? "unknown"}`,
      `error.message: ${p.error?.message ?? ""}`,
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
    `latest: ${p.last_activity?.label ?? "-"}`,
  ]
  if (p.result_text) {
    const trimmed = p.result_text.length > 1000
      ? p.result_text.slice(0, 1000) + "…(truncated)"
      : p.result_text
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
      parameters: z
        .object({
          subagent_session_id: z.string().optional(),
          tool_call_id: z.string().optional(),
          detail: z.enum(["result", "transcript"]).default("result"),
        })
        .refine(
          (v) => Boolean(v.subagent_session_id) !== Boolean(v.tool_call_id),
          { message: "exactly one of subagent_session_id or tool_call_id is required" },
        ),
      execute: (
        params: {
          subagent_session_id?: string
          tool_call_id?: string
          detail: "result" | "transcript"
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const NOT_FOUND = new Error("subagent not found or not accessible from this parent")
          const row = params.tool_call_id
            ? yield* subagentRun.read(params.tool_call_id).pipe(
                Effect.catch(() => Effect.succeed(null as MessageV2.SubtaskPart | null)),
              )
            : yield* subagentRun
                .findLatestBySessionID(ctx.sessionID, params.subagent_session_id! as SessionID)
                .pipe(Effect.catch(() => Effect.succeed(null as MessageV2.SubtaskPart | null)))
          if (!row || !row.tool_call_id) return yield* Effect.fail(NOT_FOUND)
          if (row.parent_session_id !== ctx.sessionID) return yield* Effect.fail(NOT_FOUND)
          if (row.subagent_session_id) {
            const child = yield* sessions
              .get(row.subagent_session_id as SessionID)
              .pipe(Effect.catch(() => Effect.succeed(null)))
            if (!child || !child.createdByAgentTool) return yield* Effect.fail(NOT_FOUND)
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
