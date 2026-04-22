import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { provideInstance, tmpdir } from "../fixture/fixture"

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

describe("session.system", () => {
  test("provider prompt always prepends the PawWork persona", () => {
    const prompts = SystemPrompt.provider({
      providerID: "openai",
      api: { id: "gpt-5.2" },
    } as any)

    expect(prompts[0]).toContain("PawWork")
  })

  const representativeModels = [
    { label: "gpt", providerID: "openai", api: { id: "gpt-5.2" } },
    { label: "codex", providerID: "openai", api: { id: "gpt-5.4-codex" } },
    { label: "gemini", providerID: "google", api: { id: "gemini-3-pro" } },
    { label: "claude", providerID: "anthropic", api: { id: "claude-sonnet-4" } },
    { label: "kimi", providerID: "moonshotai", api: { id: "kimi-k2.6" } },
    { label: "trinity", providerID: "opencode", api: { id: "trinity" } },
    { label: "glm", providerID: "zhipu", api: { id: "glm-5.1" } },
    { label: "qwen", providerID: "alibaba", api: { id: "qwen3-coder" } },
    { label: "unknown", providerID: "custom", api: { id: "custom-model" } },
  ] as const

  test("provider prompt is identical across model families", () => {
    const [first, ...rest] = representativeModels.map((model) => SystemPrompt.provider(model as any))

    for (const prompts of rest) {
      expect(prompts).toEqual(first)
    }
  })

  test("provider prompt uses PawWork product behavior without OpenCode support identity", () => {
    const prompt = SystemPrompt.provider(representativeModels[0] as any).join("\n")

    expect(prompt).toContain("PawWork")
    expect(prompt).toContain("understand")
    expect(prompt).toContain("execute")
    expect(prompt).toContain("parallel")
    expect(prompt).toContain("dedicated file and search tools")
    expect(prompt).not.toContain("opencode.ai")
    expect(prompt).not.toContain("anomalyco/opencode")
    expect(prompt).not.toContain("Get help with using opencode")
    expect(prompt).not.toContain("To give feedback")
  })

  test("provider prompt path has no model-family behavior routing", async () => {
    const source = await readFile(path.resolve(import.meta.dir, "../../src/session/system.ts"), "utf8")

    expect(source).not.toContain("model.api.id.includes")
    expect(source).not.toContain("toLowerCase().includes")
    expect(source).not.toContain("PROMPT_ANTHROPIC")
    expect(source).not.toContain("PROMPT_BEAST")
    expect(source).not.toContain("PROMPT_CODEX")
    expect(source).not.toContain("PROMPT_DEFAULT")
    expect(source).not.toContain("PROMPT_GEMINI")
    expect(source).not.toContain("PROMPT_GPT")
    expect(source).not.toContain("PROMPT_KIMI")
    expect(source).not.toContain("PROMPT_TRINITY")
  })

  test("session prompt files have an explicit keep inventory", async () => {
    const promptDir = path.resolve(import.meta.dir, "../../src/session/prompt")
    const files = (await readdir(promptDir)).sort()

    expect(files).toEqual(["build-switch.txt", "max-steps.txt", "pawwork.txt", "plan.txt"])
  })

  test("environment includes user locale only when provided", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = {
          providerID: "openai",
          api: { id: "gpt-5.2" },
        } as any

        const envWithLocale = await Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          return svc.environment(model, "zh-Hans").join("\n")
        }).pipe(Effect.provide(SystemPrompt.defaultLayer), Effect.runPromise)

        const envWithoutLocale = await Effect.gen(function* () {
          const svc = yield* SystemPrompt.Service
          return svc.environment(model).join("\n")
        }).pipe(Effect.provide(SystemPrompt.defaultLayer), Effect.runPromise)

        expect(envWithLocale).toContain("User locale: zh-Hans")
        expect(envWithoutLocale).not.toContain("User locale:")
      },
    })
  })

  test("skills output is sorted by name and stable across calls", async () => {
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
          const build = await load(tmp.path, (svc) => svc.get("build"))
          const runSkills = Effect.gen(function* () {
            const svc = yield* SystemPrompt.Service
            return yield* svc.skills(build!)
          }).pipe(Effect.provide(SystemPrompt.defaultLayer))

          const first = await Effect.runPromise(runSkills)
          const second = await Effect.runPromise(runSkills)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
