import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { TurnChange } from "../../src/session/turn-change"
import { AppRuntime } from "../../src/effect/app-runtime"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, SessionSummary.defaultLayer, CrossSpawnSpawner.defaultLayer))
const turnChange = await AppRuntime.runPromise(TurnChange.Service)
const recordWrite = (input: Parameters<typeof turnChange.recordWrite>[0]) =>
  AppRuntime.runSync(turnChange.recordWrite(input))
const recordUncaptured = (input: Parameters<typeof turnChange.recordUncaptured>[0]) =>
  AppRuntime.runSync(turnChange.recordUncaptured(input))
const finalize = (input: Parameters<typeof turnChange.finalize>[0]) => AppRuntime.runSync(turnChange.finalize(input))

const makeUser = Effect.fn("test.makeUser")(function* (sessionID: SessionID, suffix: string) {
  const session = yield* Session.Service
  const id = MessageID.make(`msg_artifact_user_${suffix}`)
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    tools: {},
  } as unknown as MessageV2.Info)
  return id
})

const makeAssistant = Effect.fn("test.makeAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  suffix: string,
) {
  const session = yield* Session.Service
  const id = MessageID.make(`msg_artifact_assistant_${suffix}`)
  yield* session.updateMessage({
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
})

describe("session artifacts", () => {
  it.live(
    "returns artifacts from captured and mixed aggregates while ignoring deleted and uncaptured-only changes",
    Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      return yield* provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const summary = yield* SessionSummary.Service

          const info = yield* session.create({ title: "Artifacts" })
          const user = yield* makeUser(info.id, "captured")
          const assistant = yield* makeAssistant(info.id, user, "captured")

          recordWrite({
            sessionID: info.id,
            messageID: assistant,
            path: `${dir}/artifact-report.md`,
            before: { exists: false },
            after: { exists: true, content: "report\n" },
          })
          recordWrite({
            sessionID: info.id,
            messageID: assistant,
            path: `${dir}/deleted.md`,
            before: { exists: true, content: "delete\n" },
            after: { exists: false },
          })
          recordUncaptured({ sessionID: info.id, messageID: assistant })
          finalize({ sessionID: info.id, messageID: assistant })

          const artifacts = yield* summary.artifacts({ sessionID: info.id })
          expect(artifacts).toEqual([
            {
              file: "artifact-report.md",
              kind: "added",
            },
          ])
        }),
      )
    }),
  )

  it.live(
    "returns no artifacts for empty and uncaptured-only aggregates",
    Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      return yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const summary = yield* SessionSummary.Service

          const empty = yield* session.create({ title: "Empty artifacts" })
          expect(yield* summary.artifacts({ sessionID: empty.id })).toEqual([])

          const uncaptured = yield* session.create({ title: "Uncaptured artifacts" })
          const user = yield* makeUser(uncaptured.id, "uncaptured")
          const assistant = yield* makeAssistant(uncaptured.id, user, "uncaptured")
          recordUncaptured({ sessionID: uncaptured.id, messageID: assistant })
          finalize({ sessionID: uncaptured.id, messageID: assistant })
          expect(yield* summary.artifacts({ sessionID: uncaptured.id })).toEqual([])
        }),
      )
    }),
  )
})
