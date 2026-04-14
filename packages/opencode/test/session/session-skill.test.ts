import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

describe("session.skill", () => {
  test("persists the selected skill on create and reload", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const created = await Session.create({
          title: "Document workflow",
          skill: "document-processing",
        })

        expect(created.skill).toBe("document-processing")

        const loaded = await Session.get(created.id)
        expect(loaded.skill).toBe("document-processing")
      },
    })
  })
})
