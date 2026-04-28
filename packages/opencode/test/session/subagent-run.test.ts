import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

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
