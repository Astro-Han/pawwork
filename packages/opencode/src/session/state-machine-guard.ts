import { Effect } from "effect"
import * as Session from "./session"
import * as SubagentRun from "./subagent-run"
import type { MessageID, SessionID } from "./schema"

/**
 * Returns true when the current assistant message has a tool part in pending or running state whose
 * callID differs from `exceptCallID`. Used by EnterWorktree / ExitWorktree to refuse a transition
 * while another tool call in the same turn is unresolved (the calling tool's own callID is excluded
 * so the tool can introspect itself). Historical transcript state is not live tool liveness.
 */
export const hasInFlightToolCallsExcept = (
  sessions: Session.Service["Service"],
  sessionID: SessionID,
  messageID: MessageID,
  exceptCallID: string,
) =>
  Effect.gen(function* () {
    const messages = yield* sessions.messages({ sessionID })
    for (const m of messages) {
      if (m.info.id !== messageID) continue
      for (const part of m.parts) {
        if (part.type !== "tool") continue
        if (part.messageID !== messageID) continue
        if (part.callID === exceptCallID) continue
        if (part.state.status === "running" || part.state.status === "pending") return true
      }
    }
    return false
  })

/**
 * Returns true when this session has at least one active subagent run.
 */
export const hasRunningSubagents = (
  subagents: SubagentRun.Service["Service"],
  sessionID: SessionID,
) => subagents.activeForSession(sessionID)
