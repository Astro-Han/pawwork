import { describe, expect, test } from "bun:test"
import { dict as zh } from "@/i18n/zh"
import { dict as en } from "@/i18n/en"

describe("settings.permissions.tool.agent i18n (#128)", () => {
  test("agent keys exist with agreed values (zh)", () => {
    expect((zh as Record<string, string>)["settings.permissions.tool.agent.title"]).toBe("子智能体")
    expect((zh as Record<string, string>)["settings.permissions.tool.agent.description"]).toBe("启动子智能体")
  })

  test("agent keys exist with agreed values (en)", () => {
    expect((en as Record<string, string>)["settings.permissions.tool.agent.title"]).toBe("Subagent")
    expect((en as Record<string, string>)["settings.permissions.tool.agent.description"]).toBe("Launch a subagent")
  })

  test("legacy task keys do not exist (zh)", () => {
    expect((zh as Record<string, unknown>)["settings.permissions.tool.task.title"]).toBeUndefined() // agent-rename:legacy-render
    expect((zh as Record<string, unknown>)["settings.permissions.tool.task.description"]).toBeUndefined() // agent-rename:legacy-render
  })

  test("legacy task keys do not exist (en)", () => {
    expect((en as Record<string, unknown>)["settings.permissions.tool.task.title"]).toBeUndefined() // agent-rename:legacy-render
    expect((en as Record<string, unknown>)["settings.permissions.tool.task.description"]).toBeUndefined() // agent-rename:legacy-render
  })
})
