import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, ManagedRuntime, Schema } from "effect"
import { AutomateParameters, createAutomateDefinition, formatAutomateValidationError } from "../../src/tool/automate"
import { Automation } from "../../src/automation"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { NotFoundError } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"
import { fakeAutomationProvider } from "../fake/provider"

const { providerID: fakeProviderID, modelID: fakeModelID, interface: fakeProviderInterface } = fakeAutomationProvider()

// createAutomateDefinition now takes the resolved Automation service (injected
// in production from AppRuntime, like provider). Resolve it once for the tests.
const runtime = ManagedRuntime.make(Automation.defaultLayer)
const automation = await runtime.runPromise(Effect.gen(function* () { return yield* Automation.Service }))

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
      sourceSessionID: SessionID.descending(),
      rhythm: { kind: "interval", everyMs: 60_000 },
    })

    expect(decoded).toEqual({ title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" })
  })

  test("decode keeps continueSession on the surface", () => {
    const decoded = Schema.decodeUnknownSync(AutomateParameters)({
      title: "Daily repo brief",
      prompt: "Summarize repo changes.",
      cron: "0 9 * * *",
      continueSession: true,
    })

    expect(decoded.continueSession).toBe(true)
  })

  test("decode strips a spoofed sourceSessionID even alongside continueSession", () => {
    const decoded = Schema.decodeUnknownSync(AutomateParameters)({
      title: "Standup digest",
      prompt: "Continue the running digest.",
      cron: "0 9 * * *",
      continueSession: true,
      sourceSessionID: SessionID.descending(),
    })

    // continueSession is on the surface; sourceSessionID is not. Decode is the
    // boundary tool.ts runs before execute, so the spoof is dropped here — a
    // model that opts into continue still cannot name which conversation it
    // runs in; sourceSessionID always comes from the tool context.
    expect(decoded).toEqual({
      title: "Standup digest",
      prompt: "Continue the running digest.",
      cron: "0 9 * * *",
      continueSession: true,
    })
  })

  test("creates a recurring cron automation, defaulting project/timezone/model to the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
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
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
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
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
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
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
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

  test("a non-NotFound failure reading the session messages fails the tool instead of silently using the default model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const streamSpy = spyOn(MessageV2, "stream").mockImplementation((() => {
          throw new Error("storage corrupt")
        }) as typeof MessageV2.stream)
        try {
          const tool = createAutomateDefinition(fakeProviderInterface, automation)
          let error: unknown
          try {
            await Effect.runPromise(
              tool.execute(
                { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" },
                ctx(SessionID.descending()),
              ),
            )
          } catch (caught) {
            error = caught
          }

          expect(String(error)).toContain("storage corrupt")
          expect(Automation.list()).toHaveLength(0)
        } finally {
          streamSpy.mockRestore()
        }
      },
    })
  })

  test("a missing session (NotFound) still falls back to the provider default model", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const streamSpy = spyOn(MessageV2, "stream").mockImplementation((() => {
          throw new NotFoundError({ message: "Session not found" })
        }) as typeof MessageV2.stream)
        try {
          const tool = createAutomateDefinition(fakeProviderInterface, automation)
          const result = await Effect.runPromise(
            tool.execute(
              { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" },
              ctx(SessionID.descending()),
            ),
          )

          expect(result.metadata.automationDefinition.model).toEqual({
            providerID: fakeProviderID,
            modelID: fakeModelID,
          })
        } finally {
          streamSpy.mockRestore()
        }
      },
    })
  })

  test("one-shot fireAt is sampled after model validation, so a crossed cron boundary never yields an already-due fire", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const boundary = Date.UTC(2026, 0, 1, 12, 1, 0)
        let clock = boundary - 1_000
        const nowSpy = spyOn(Date, "now").mockImplementation(() => clock)
        // Validation crosses the minute boundary. If now were sampled before
        // validation, the one-shot would fire at 12:01:00 (already due); sampling
        // after pushes it to 12:02:00.
        const slowProvider: Provider.Interface = {
          ...fakeProviderInterface,
          getModel: ((pId, mId) => {
            clock = boundary + 1_000
            return fakeProviderInterface.getModel(pId, mId)
          }) as Provider.Interface["getModel"],
        }
        try {
          const tool = createAutomateDefinition(slowProvider, automation)
          const result = await Effect.runPromise(
            tool.execute(
              {
                title: "One-off brief",
                prompt: "Summarize repo changes.",
                cron: "* * * * *",
                recurring: false,
                timezone: "UTC",
              },
              ctx(SessionID.descending()),
            ),
          )

          const definition = result.metadata.automationDefinition
          expect(definition.kind).toBe("oneshot")
          expect(definition.kind === "oneshot" && definition.fireAt).toBe(Date.UTC(2026, 0, 1, 12, 2, 0))
        } finally {
          nowSpy.mockRestore()
        }
      },
    })
  })

  test("binds sourceSessionID to the tool context and ignores any spoofed identity fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
        const sourceSessionID = SessionID.descending()
        const spoof = {
          sourceSessionID: SessionID.descending(),
        } as Record<string, unknown>
        const result = await Effect.runPromise(
          tool.execute(
            { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *", ...spoof },
            ctx(sourceSessionID),
          ),
        )

        // The spoofed sourceSessionID in input is ignored; the binding comes
        // from the tool context (which conversation the model is running in).
        const definition = result.metadata.automationDefinition
        expect(definition.sourceSessionID).toBe(sourceSessionID)
      },
    })
  })

  test("defaults to a fresh session per run when continueSession is omitted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
        const result = await Effect.runPromise(
          tool.execute(
            { title: "Daily repo brief", prompt: "Summarize repo changes.", cron: "0 9 * * *" },
            ctx(SessionID.descending()),
          ),
        )

        expect(result.metadata.automationDefinition.context).toBe("fresh")
      },
    })
  })

  test("continueSession:true maps to context continue and binds the source conversation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
        const sourceSessionID = SessionID.descending()
        const result = await Effect.runPromise(
          tool.execute(
            {
              title: "Standup digest",
              prompt: "Continue the running digest.",
              cron: "0 9 * * *",
              continueSession: true,
            },
            ctx(sourceSessionID),
          ),
        )

        const definition = result.metadata.automationDefinition
        expect(definition.context).toBe("continue")
        // A continue automation runs inside the conversation it was created in,
        // so it is bound to that source session at creation (from the tool
        // context). Every run then appends to that same conversation.
        expect(definition.sourceSessionID).toBe(sourceSessionID)
      },
    })
  })

  test("continueSession on a one-shot is allowed and maps to a continue one-shot (orthogonal, not rejected)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = createAutomateDefinition(fakeProviderInterface, automation)
        const result = await Effect.runPromise(
          tool.execute(
            {
              title: "One-off digest",
              prompt: "Summarize once.",
              cron: "0 9 * * *",
              recurring: false,
              continueSession: true,
            },
            ctx(SessionID.descending()),
          ),
        )

        const definition = result.metadata.automationDefinition
        // continueSession stays orthogonal to recurring: the flat surface adds no
        // cross-field rule. A one-shot fires once with no prior session, so the
        // runner creates fresh anyway — harmless, so the combo is intentionally
        // not rejected. Pinned here to guard against a regression that adds one.
        expect(definition.kind).toBe("oneshot")
        expect(definition.context).toBe("continue")
      },
    })
  })
})
