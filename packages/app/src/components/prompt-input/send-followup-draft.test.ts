import { beforeEach, describe, expect, test } from "bun:test"
import { sendFollowupDraft } from "./send-followup-draft"

const commandCalls: Array<Record<string, unknown>> = []

const clientFor = () => ({
  session: {
    command: async (input: Record<string, unknown>) => {
      commandCalls.push(input)
      return { data: undefined }
    },
  },
})

beforeEach(() => {
  commandCalls.length = 0
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
})
