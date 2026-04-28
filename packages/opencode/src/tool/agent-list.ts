import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { SubagentRun } from "../session/subagent-run"
import type { MessageV2 } from "../session/message-v2"

export const Parameters = Schema.Struct({
  status: Schema.Literals([
    "running",
    "completed",
    "completed_empty",
    "failed",
    "canceled_by_user",
    "all_active",
    "all",
  ]).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("all_active" as const))),
  limit: Schema.Number.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(5))),
})

const formatElapsed = (ms: number): string => {
  // Negative durations imply clock skew (started_at in the future). Surface "-" so the
  // anomaly is visible instead of silently rendered as 0s.
  if (ms < 0) return "-"
  const s = Math.floor(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h${String(m).padStart(2, "0")}`
}

const truncateActivity = (s: string): string => (s.length > 60 ? s.slice(0, 59) + "…" : s)

const formatRow = (p: MessageV2.SubtaskPart, now: number): string => {
  const isLegacy = !p.tool_call_id || !p.started_at
  const elapsed = isLegacy ? "-" : formatElapsed(now - (p.started_at ?? now))
  const statusLabel =
    p.status === "running" ? "running" : p.consumed_at ? p.status : `${p.status} (unread)`
  const activity = p.result_summary ?? (isLegacy ? "(legacy)" : "")
  return [
    p.subagent_session_id ?? "-",
    statusLabel,
    p.description,
    `latest: ${truncateActivity(activity)}`,
    elapsed,
  ].join(" | ")
}

export const AgentListTool = Tool.define(
  "agent_list",
  Effect.gen(function* () {
    const subagentRun = yield* SubagentRun.Service

    return {
      description:
        "List subagents launched by this parent session. Filter by lifecycle status; default `all_active` shows running plus unread terminal rows.",
      parameters: Parameters,
      execute: (
        params: { status: SubagentRun.AgentListFilter; limit: number },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const rows = yield* subagentRun.list(ctx.sessionID, {
            status: params.status,
            limit: params.limit,
          })
          const now = Date.now()
          const lines = rows.map((p) => formatRow(p, now))
          return {
            title: "agent_list",
            metadata: { count: rows.length, status: params.status },
            output: lines.length > 0 ? lines.join("\n") : "(no subagents match this filter)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
