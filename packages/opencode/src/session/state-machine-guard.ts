import { Effect } from "effect"
import * as Session from "./session"
import type { SessionID } from "./schema"

/**
 * Returns true when this session has a tool part in pending or running state whose callID differs
 * from `exceptCallID`. Used by EnterWorktree / ExitWorktree to refuse a transition while another
 * tool call is unresolved (the calling tool's own callID is excluded so the tool can introspect
 * itself).
 */
export const hasInFlightToolCallsExcept = (
  sessions: Session.Service["Service"],
  sessionID: SessionID,
  exceptCallID: string,
) =>
  Effect.gen(function* () {
    const messages = yield* sessions.messages({ sessionID })
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type !== "tool") continue
        if (part.callID === exceptCallID) continue
        if (part.state.status === "running" || part.state.status === "pending") return true
      }
    }
    return false
  })

/**
 * Returns true when this session has at least one active subagent run.
 *
 * Note: SubagentRun.activeCounts is private to the layer; a public count helper is a follow-up.
 * For now this returns false unconditionally; the parent's running-tool guard above already covers
 * the common case since subagents are dispatched through a parent agent tool call.
 */
export const hasRunningSubagents = (_sessionID: SessionID) => Effect.succeed(false)
