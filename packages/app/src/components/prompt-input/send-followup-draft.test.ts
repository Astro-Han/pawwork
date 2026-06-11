import { beforeEach, describe, expect, test } from "bun:test"
import { sendFollowupDraft } from "./send-followup-draft"

const commandCalls: Array<Record<string, unknown>> = []
const promptAsyncCalls: Array<Record<string, unknown>> = []

const clientFor = () => ({
  session: {
    command: async (input: Record<string, unknown>) => {
      commandCalls.push(input)
      return { data: undefined }
    },
    promptAsync: async (input: Record<string, unknown>) => {
      promptAsyncCalls.push(input)
      return { data: undefined }
    },
  },
})

beforeEach(() => {
  commandCalls.length = 0
  promptAsyncCalls.length = 0
})

describe("sendFollowupDraft", () => {
  test("sends locale with slash-command followups", async () => {
    await sendFollowupDraft({
      client: clientFor() as any,
      globalSync: {
        child: () => [{}, () => undefined],
      } as any,
      sync: {
        data: { command: [{ name: "summarize" }], command_ready: true },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as any,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "/summarize this", start: 0, end: 15 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        locale: "zh-Hans",
      },
    })

    expect(commandCalls.at(-1)?.locale).toBe("zh-Hans")
  })

  test("sends chip attachment parts with slash-command and normal followups", async () => {
    const base = {
      client: clientFor() as any,
      globalSync: { child: () => [{}, () => undefined] } as any,
      sync: {
        data: { command: [{ name: "summarize" }], command_ready: true },
        session: { optimistic: { add: () => undefined, remove: () => undefined } },
      } as any,
    }
    const chip = { type: "attachment" as const, id: "att_1", path: "/Users/me/shot.png", filename: "shot.png" }

    await sendFollowupDraft({
      ...base,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "/summarize this", start: 0, end: 15 }, chip],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    const commandParts = commandCalls.at(-1)?.parts as Array<Record<string, unknown>>
    expect(commandParts.some((part) => part.type === "file" && part.url === "file:///Users/me/shot.png")).toBe(true)

    await sendFollowupDraft({
      ...base,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "look", start: 0, end: 4 }, chip],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
    })

    const promptParts = promptAsyncCalls.at(-1)?.parts as Array<Record<string, unknown>>
    expect(promptParts.some((part) => part.type === "file" && part.url === "file:///Users/me/shot.png")).toBe(true)
  })

  test("sends file attachment parts with slash-command followups", async () => {
    await sendFollowupDraft({
      client: clientFor() as any,
      globalSync: {
        child: () => [{}, () => undefined],
      } as any,
      sync: {
        data: { command: [{ name: "summarize" }], command_ready: true },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as any,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [
          { type: "text", content: "/summarize ", start: 0, end: 11 },
          { type: "file", path: "guide.pdf", content: "@guide.pdf", start: 11, end: 21 },
        ],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        locale: "zh-Hans",
      },
    })

    expect(commandCalls.at(-1)?.parts).toEqual([
      {
        id: expect.any(String),
        type: "file",
        mime: "text/plain",
        url: "file:///repo/main/guide.pdf",
        filename: "guide.pdf",
        source: {
          type: "file",
          text: { value: "@guide.pdf", start: 11, end: 21 },
          path: "/repo/main/guide.pdf",
        },
      },
    ])
  })

  test("sends file attachment parts with normal followups", async () => {
    await sendFollowupDraft({
      client: clientFor() as any,
      globalSync: {
        child: () => [{}, () => undefined],
      } as any,
      sync: {
        data: { command: [], command_ready: true },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as any,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "file", path: "guide.pdf", content: "@guide.pdf", start: 0, end: 10 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        locale: "zh-Hans",
      },
    })

    const parts = promptAsyncCalls.at(-1)?.parts as Array<Record<string, unknown>>
    expect(parts.some((part) => part.type === "file" && part.url === "file:///repo/main/guide.pdf")).toBe(true)
  })
})
