import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AutomateParameters, createAutomateDefinition, formatAutomateValidationError } from "../../src/tool/automate"
import { Automation } from "../../src/automation"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("automate tool", () => {
  test("validation errors name the wrong field and show the expected shape", () => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({
        kind: "recurring",
        title: "Missing prompt",
        context: "fresh",
        where: { projectID: "project" },
        timezone: "UTC",
        rhythm: { kind: "interval", everyMs: 60_000 },
        stop: { kind: "never" },
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("prompt")
    expect(formatAutomateValidationError(error)).toContain("kind, title, prompt, context, where, timezone")
  })

  test("rejects empty strings before execute reaches the Zod create parser", () => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({
        kind: "recurring",
        title: "",
        prompt: "Summarize repo changes.",
        context: "fresh",
        where: { projectID: "project", worktree: "" },
        timezone: "",
        rhythm: { kind: "interval", everyMs: 60_000 },
        stop: { kind: "never" },
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
  })

  test.each([
    ["negative fireAt", { kind: "oneshot", fireAt: -1 }],
    ["fractional fireAt", { kind: "oneshot", fireAt: 1.5 }],
    ["zero interval", { kind: "recurring", rhythm: { kind: "interval", everyMs: 0 }, stop: { kind: "never" } }],
    ["interval below floor", { kind: "recurring", rhythm: { kind: "interval", everyMs: 29_999 }, stop: { kind: "never" } }],
    ["fractional interval", { kind: "recurring", rhythm: { kind: "interval", everyMs: 1.5 }, stop: { kind: "never" } }],
    ["zero count", { kind: "recurring", rhythm: { kind: "interval", everyMs: 60_000 }, stop: { kind: "count", count: 0 } }],
    ["fractional count", { kind: "recurring", rhythm: { kind: "interval", everyMs: 60_000 }, stop: { kind: "count", count: 1.5 } }],
  ])("rejects invalid numeric fields before execute reaches the Zod create parser: %s", (_name, override) => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    const base = {
      title: "Daily repo brief",
      prompt: "Summarize repo changes.",
      context: "fresh",
      where: { projectID: "project" },
      timezone: "UTC",
    }
    let error: unknown
    try {
      decode({ ...base, ...override })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
  })

  test.each([
    ["empty cron expression", { rhythm: { kind: "cron", expression: "" }, stop: { kind: "never" } }],
    ["empty stop condition", { rhythm: { kind: "interval", everyMs: 60_000 }, stop: { kind: "condition", condition: "" } }],
  ])("rejects empty nested strings before execute reaches the Zod create parser: %s", (_name, override) => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({
        kind: "recurring",
        title: "Daily repo brief",
        prompt: "Summarize repo changes.",
        context: "fresh",
        where: { projectID: "project" },
        timezone: "UTC",
        ...override,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
  })

  test.each([
    ["sourceSessionID", { sourceSessionID: "not-a-session-id" }],
    ["automationSessionID", { automationSessionID: "not-a-session-id" }],
  ])("rejects invalid session ids before execute reaches the Zod create parser: %s", (_name, override) => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({
        kind: "recurring",
        title: "Daily repo brief",
        prompt: "Summarize repo changes.",
        context: "fresh",
        where: { projectID: "project" },
        timezone: "UTC",
        rhythm: { kind: "interval", everyMs: 60_000 },
        stop: { kind: "never" },
        ...override,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
  })

  test.each([
    ["invalid timezone", { timezone: "Not/AZone" }],
    ["invalid cron expression", { rhythm: { kind: "cron", expression: "not cron" } }],
    ["bare session prefix", { sourceSessionID: "ses" }],
    ["malformed session id", { automationSessionID: "ses_bad" }],
  ])("rejects semantic validation before execute reaches the Zod create parser: %s", (_name, override) => {
    const decode = Schema.decodeUnknownSync(AutomateParameters)
    let error: unknown
    try {
      decode({
        kind: "recurring",
        title: "Daily repo brief",
        prompt: "Summarize repo changes.",
        context: "fresh",
        where: { projectID: "project" },
        timezone: "UTC",
        rhythm: { kind: "interval", everyMs: 60_000 },
        stop: { kind: "never" },
        ...override,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeDefined()
    expect(formatAutomateValidationError(error)).toContain("Invalid automate input")
  })

  test.each([
    ["wrong project", () => ({ projectID: "other-project" }), "where.projectID"],
    ["worktree placement", (projectID: string) => ({ projectID, worktree: "feature" }), "where.worktree"],
  ])("reports execute-time automation validation as model-readable input errors: %s", async (_name, where, field) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition()
        const sourceSessionID = SessionID.descending()
        let error: unknown
        try {
          await Effect.runPromise(
            tool.execute(
              {
                kind: "recurring",
                title: "Daily repo brief",
                prompt: "Summarize repo changes.",
                context: "fresh",
                where: where(Instance.project.id),
                timezone: "UTC",
                rhythm: { kind: "interval", everyMs: 60_000 },
                stop: { kind: "never" },
              },
              {
                sessionID: sourceSessionID,
                messageID: MessageID.ascending(),
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            ),
          )
        } catch (caught) {
          error = caught
        }

        expect(String(error)).toContain("Invalid automate input")
        expect(String(error)).toContain(field)
        expect(Automation.list()).toHaveLength(0)
      },
    })
  })

  test("echoes the resolved definition through the automation create path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition()
        const sourceSessionID = SessionID.descending()
        const result = await Effect.runPromise(
          tool.execute(
            {
              kind: "recurring",
              title: "Daily repo brief",
              prompt: "Summarize repo changes.",
              context: "fresh",
              where: { projectID: Instance.project.id },
              timezone: "Asia/Shanghai",
              rhythm: { kind: "interval", everyMs: 60_000 },
              stop: { kind: "never" },
            },
            {
              sessionID: sourceSessionID,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )

        expect(result.title).toBe("Automation created")
        expect(result.metadata.automationDefinition).toMatchObject({
          title: "Daily repo brief",
          prompt: "Summarize repo changes.",
          revision: 1,
          paused: false,
          where: { projectID: Instance.project.id },
          sourceSessionID,
        })
        expect(Automation.list()).toHaveLength(1)
      },
    })
  })

  test("binds sourceSessionID to the current tool context even when input tries to spoof it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition()
        const sourceSessionID = SessionID.descending()
        const spoofedSessionID = SessionID.descending()
        const result = await Effect.runPromise(
          tool.execute(
            {
              kind: "recurring",
              title: "Daily repo brief",
              prompt: "Summarize repo changes.",
              context: "fresh",
              where: { projectID: Instance.project.id },
              timezone: "Asia/Shanghai",
              sourceSessionID: spoofedSessionID,
              rhythm: { kind: "interval", everyMs: 60_000 },
              stop: { kind: "never" },
            },
            {
              sessionID: sourceSessionID,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          ),
        )

        expect(result.metadata.automationDefinition.sourceSessionID).toBe(sourceSessionID)
      },
    })
  })
})
