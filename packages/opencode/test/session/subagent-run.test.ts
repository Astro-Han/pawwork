import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "@opencode-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

describe("SubtaskPart backward compat", () => {
  test("decodes a legacy row lacking lifecycle fields as terminal-completed", () => {
    const legacy = {
      type: "subtask" as const,
      id: "prt_legacy",
      sessionID: "ses_x",
      messageID: "msg_x",
      prompt: "old",
      description: "old",
      agent: "build",
    }
    const decoded = MessageV2.SubtaskPart.parse(legacy)
    expect(decoded.status).toBe("completed")
    expect(decoded.recent_events).toEqual([])
    expect(decoded.started_at).toBeUndefined()
    expect(decoded.tool_call_id).toBeUndefined()
  })

  test("accepts a row with all new lifecycle fields populated", () => {
    const full = {
      type: "subtask" as const,
      id: "prt_new",
      sessionID: "ses_x",
      messageID: "msg_x",
      prompt: "p",
      description: "d",
      agent: "build",
      tool_call_id: "call_1",
      parent_session_id: "ses_x",
      parent_message_id: "msg_x",
      subagent_session_id: "ses_child",
      status: "running" as const,
      started_at: 1000,
      updated_at: 1500,
      recent_events: [{ type: "started" as const, at: 1000 }],
    }
    const decoded = MessageV2.SubtaskPart.parse(full)
    expect(decoded.status).toBe("running")
    expect(decoded.tool_call_id).toBe("call_1")
    expect(decoded.recent_events).toHaveLength(1)
  })
})

describe("Session.create new fields", () => {
  test("persists createdByAgentTool and subagentType", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await Session.create({
          title: "child",
          createdByAgentTool: true,
          subagentType: "reviewer",
        })
        const fetched = await Session.get(created.id)
        expect(fetched.createdByAgentTool).toBe(true)
        expect(fetched.subagentType).toBe("reviewer")
      },
    })
  })

  test("defaults are false / null when not provided", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await Session.create({ title: "plain" })
        const fetched = await Session.get(created.id)
        expect(fetched.createdByAgentTool).toBe(false)
        expect(fetched.subagentType).toBeNull()
      },
    })
  })
})
