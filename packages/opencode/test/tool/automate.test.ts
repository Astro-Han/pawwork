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

  test("echoes the resolved definition through the automation create path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition()
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
              sessionID: SessionID.descending(),
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
        })
        expect(Automation.list()).toHaveLength(1)
      },
    })
  })
})
