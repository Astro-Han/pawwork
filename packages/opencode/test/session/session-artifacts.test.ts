import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { tmpdir } from "../fixture/fixture"

describe("session artifacts", () => {
  test("keeps files that were added in earlier turns even if later turns delete them", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Artifacts" })

        const firstMessage: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          tools: {},
          summary: {
            diffs: [
              {
                file: "artifact-report.md",
                patch: "",
                additions: 2,
                deletions: 0,
                status: "added",
              },
            ],
          },
        }

        const secondMessage: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() + 1 },
          agent: "test",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          tools: {},
          summary: {
            diffs: [
              {
                file: "artifact-report.md",
                patch: "",
                additions: 0,
                deletions: 2,
                status: "deleted",
              },
            ],
          },
        }

        await Session.updateMessage(firstMessage)
        await Session.updateMessage(secondMessage)

        const artifacts = await SessionSummary.artifacts({ sessionID: session.id })
        expect(artifacts).toEqual([
          {
            file: "artifact-report.md",
            kind: "added",
          },
        ])
      },
    })
  })
})
