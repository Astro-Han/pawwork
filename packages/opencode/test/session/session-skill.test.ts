import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const runSession = <A>(fn: (svc: Session.Interface) => Effect.Effect<A>) => AppRuntime.runPromise(Session.Service.use(fn))

describe("session.skill", () => {
  test("persists the selected skill on create and reload", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await runSession((svc) =>
          svc.create({
            title: "Document workflow",
            skill: "officecli-docx",
          }),
        )

        expect(created.skill).toBe("officecli-docx")

        const loaded = await runSession((svc) => svc.get(created.id))
        expect(loaded.skill).toBe("officecli-docx")
      },
    })
  })
})
