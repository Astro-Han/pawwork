import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Storage } from "../../src/storage/storage"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { tmpdir } from "../fixture/fixture"
import { Effect } from "effect"

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

  test("redacts sensitive stored session diffs before returning or rewriting them", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Sensitive diff" })
        const rawDiff = [
          {
            file: ".env",
            patch: "@@\n-TOKEN=old-secret\n+TOKEN=new-secret\n",
            additions: 1,
            deletions: 1,
            status: "modified" as const,
          },
        ]

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const storage = yield* Storage.Service
            yield* storage.write(["session_diff", session.id], rawDiff)
          }),
        )

        const diff = await SessionSummary.diff({ sessionID: session.id })
        const serialized = JSON.stringify(diff)

        expect(serialized).not.toContain("old-secret")
        expect(serialized).not.toContain("new-secret")
        expect(diff as unknown).toEqual([
          { file: ".env", patch: "", additions: 0, deletions: 0, status: "modified", sensitive: true },
        ])

        const stored = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const storage = yield* Storage.Service
            return yield* storage.read<typeof diff>(["session_diff", session.id])
          }),
        )
        expect(stored).toEqual(diff)
      },
    })
  })
})
