import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { TurnChange } from "../../src/session/turn-change"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

async function makeUser(sessionID: SessionID, suffix: string) {
  const id = MessageID.make(`msg_artifact_user_${suffix}`)
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    tools: {},
  } as unknown as MessageV2.Info)
  return id
}

async function makeAssistant(sessionID: SessionID, parentID: MessageID, suffix: string) {
  const id = MessageID.make(`msg_artifact_assistant_${suffix}`)
  await Session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return id
}

describe("session artifacts", () => {
  test("returns artifacts from captured and mixed aggregates while ignoring deleted and uncaptured-only changes", async () => {
    await resetDatabase()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Artifacts" })
        const user = await makeUser(session.id, "captured")
        const assistant = await makeAssistant(session.id, user, "captured")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: assistant,
          path: `${tmp.path}/artifact-report.md`,
          before: { exists: false },
          after: { exists: true, content: "report\n" },
        })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: assistant,
          path: `${tmp.path}/deleted.md`,
          before: { exists: true, content: "delete\n" },
          after: { exists: false },
        })
        TurnChange.recordUncaptured({ sessionID: session.id, messageID: assistant })
        TurnChange.finalize({ sessionID: session.id, messageID: assistant })

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

  test("returns no artifacts for empty and uncaptured-only aggregates", async () => {
    await resetDatabase()
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const empty = await Session.create({ title: "Empty artifacts" })
        expect(await SessionSummary.artifacts({ sessionID: empty.id })).toEqual([])

        const uncaptured = await Session.create({ title: "Uncaptured artifacts" })
        const user = await makeUser(uncaptured.id, "uncaptured")
        const assistant = await makeAssistant(uncaptured.id, user, "uncaptured")
        TurnChange.recordUncaptured({ sessionID: uncaptured.id, messageID: assistant })
        expect(await SessionSummary.artifacts({ sessionID: uncaptured.id })).toEqual([])
      },
    })
  })
})
