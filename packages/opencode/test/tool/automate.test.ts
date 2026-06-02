import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AutomateParameters, createAutomateDefinition, formatAutomateValidationError } from "../../src/tool/automate"
import { Automation } from "../../src/automation"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { fakeAutomationProvider } from "../fake/provider"

const { providerID: fakeProviderID, modelID: fakeModelID, interface: fakeProviderInterface } = fakeAutomationProvider()

const ctx = (sessionID: SessionID) => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("automate tool", () => {
  test("decode rejects a missing required field and shows the flat shape", () => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({ title: "Daily repo brief", cron: "0 9 * * *" })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
    expect(formatAutomateValidationError(error)).toContain("prompt")
  })

  test.each([
    ["empty title", { title: "" }],
    ["empty prompt", { prompt: "" }],
    ["empty cron", { cron: "" }],
    ["invalid cron", { cron: "not cron" }],
    ["invalid timezone", { timezone: "Not/AZone" }],
    ["title above replay-safe limit", { title: "x".repeat(161) }],
    ["prompt above replay-safe limit", { prompt: "x".repeat(20_001) }],
  ])("decode rejects invalid input before execute: %s", (_name, override) => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({ title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *", ...override })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
  })

  test("decode strips fields the surface does not expose (spoof + frozen-only knobs)", () => {
    const decoded = Schema.decodeUnknownSync(AutomateParameters)({
      title: "Daily repo brief",
      prompt: "Summarize repo changes.",
      cron: "0 9 * * *",
      where: { projectID: "spoofed" },
      automationSessionID: SessionID.descending(),
      sourceSessionID: SessionID.descending(),
      rhythm: { kind: "interval", everyMs: 60_000 },
    })

    expect(decoded).toEqual({ title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" })
  })

  test("creates a recurring cron automation, defaulting project/timezone/model to the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface)
        const sourceSessionID = SessionID.descending()
        const result = await Effect.runPromise(
          tool.execute(
            { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" },
            ctx(sourceSessionID),
          ),
        )

        expect(result.title).toBe("Automation created")
        const definition = result.metadata.automationDefinition
        expect(definition).toMatchObject({
          kind: "recurring",
          title: "Daily repo brief",
          prompt: "Summarize repo changes.",
          revision: 1,
          paused: false,
          where: { projectID: Instance.project.id },
          model: { providerID: fakeProviderID, modelID: fakeModelID },
          sourceSessionID,
        })
        expect(definition.kind === "recurring" && definition.rhythm).toEqual({ kind: "cron", expression: "0 9 * * *" })
        expect(Automation.isValidTimezone(definition.timezone)).toBe(true)
        expect(Automation.list()).toHaveLength(1)
      },
    })
  })

  test("recurring:false creates a one-shot fired at the next cron match", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface)
        const before = Date.now()
        const result = await Effect.runPromise(
          tool.execute(
            { title: "One-off brief", prompt: "Summarize repo changes.", cron: "0 9 * * *", recurring: false },
            ctx(SessionID.descending()),
          ),
        )

        const definition = result.metadata.automationDefinition
        expect(definition.kind).toBe("oneshot")
        expect(definition.kind === "oneshot" && definition.fireAt).toBeGreaterThan(before)
      },
    })
  })

  test("honors an explicit flat model override and variant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface)
        const result = await Effect.runPromise(
          tool.execute(
            {
              title: "Daily repo brief",
              prompt: "Summarize repo changes.",
              cron: "0 9 * * *",
              model: `${fakeProviderID}/${fakeModelID}`,
              variant: "high",
            },
            ctx(SessionID.descending()),
          ),
        )

        expect(result.metadata.automationDefinition).toMatchObject({
          model: { providerID: fakeProviderID, modelID: fakeModelID },
          variant: "high",
        })
      },
    })
  })

  test("surfaces execute-time model validation as a readable input error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface)
        let error: unknown
        try {
          await Effect.runPromise(
            tool.execute(
              {
                title: "Daily repo brief",
                prompt: "Summarize repo changes.",
                cron: "0 9 * * *",
                model: `${fakeProviderID}/does-not-exist`,
              },
              ctx(SessionID.descending()),
            ),
          )
        } catch (caught) {
          error = caught
        }

        expect(String(error)).toContain("Invalid automate input")
        expect(String(error)).toContain("model")
        expect(Automation.list()).toHaveLength(0)
      },
    })
  })

  test("binds sourceSessionID to the tool context and ignores any spoofed identity fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface)
        const sourceSessionID = SessionID.descending()
        const spoof = {
          sourceSessionID: SessionID.descending(),
          automationSessionID: SessionID.descending(),
        } as Record<string, unknown>
        const result = await Effect.runPromise(
          tool.execute(
            { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *", ...spoof },
            ctx(sourceSessionID),
          ),
        )

        const definition = result.metadata.automationDefinition
        expect(definition.sourceSessionID).toBe(sourceSessionID)
        expect(definition.automationSessionID).toBeUndefined()
      },
    })
  })
})
