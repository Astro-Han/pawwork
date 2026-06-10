import { Effect, Layer, ManagedRuntime } from "effect"
import { Agent } from "../../src/agent/agent"
import { Skill } from "../../src/skill"
import { Ripgrep } from "../../src/file/ripgrep"
import { Truncate } from "../../src/tool/truncate"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.skill", () => {
  test("description does not duplicate the available skill catalog", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const desc = await ToolRegistry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
          }).then((tools) => tools.find((tool) => tool.id === SkillTool.id)?.description ?? "")
          expect(desc).toContain("Load a specialized skill")
          expect(desc).not.toContain("tool-skill")
          expect(desc).not.toContain("Skill for tool tests.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("description is stable across calls without listing available skills", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const load = () =>
            ToolRegistry.tools({
              providerID: "opencode" as any,
              modelID: "gpt-5" as any,
              agent,
            }).then((tools) => tools.find((tool) => tool.id === SkillTool.id)?.description ?? "")
          const first = await load()
          const second = await load()

          expect(first).toBe(second)
          expect(first).not.toContain("alpha-skill")
          expect(first).not.toContain("middle-skill")
          expect(first).not.toContain("zeta-skill")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("description omits manual-only skills without appending an empty catalog", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "manual-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: manual-skill
---

# Manual Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = {
            name: "build",
            mode: "primary" as const,
            permission: [
              { permission: "skill", pattern: "*", action: "deny" as const },
              { permission: "skill", pattern: "manual-skill", action: "allow" as const },
            ],
            options: {},
          }
          const desc = await ToolRegistry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          }).then((tools) => tools.find((tool) => tool.id === SkillTool.id)?.description ?? "")

          expect(desc).toContain("Load a specialized skill")
          expect(desc).not.toContain("No skills are currently available.")
          expect(desc).not.toContain("manual-skill")
          expect(desc).not.toContain("The following skills provide specialized sets of instructions")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("execute returns skill content block with files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        )
        await Bun.write(path.join(skillDir, "scripts", "demo.txt"), "demo")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const runtime = ManagedRuntime.make(
            Layer.mergeAll(Skill.defaultLayer, Ripgrep.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
          )
          const info = await runtime.runPromise(SkillTool)
          const tool = await runtime.runPromise(info.init())
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = await runtime.runPromise(tool.execute({ name: "tool-skill" }, ctx))
          const dir = path.join(tmp.path, ".opencode", "skill", "tool-skill")
          const file = path.resolve(dir, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")

          expect(result.metadata.dir).toBe(dir)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
