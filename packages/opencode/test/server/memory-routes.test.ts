import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { MemoryRoutes } from "../../src/server/instance/memory"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const originalPawWorkHome = process.env.PAWWORK_HOME

afterEach(async () => {
  if (originalPawWorkHome === undefined) delete process.env.PAWWORK_HOME
  else process.env.PAWWORK_HOME = originalPawWorkHome
  await Instance.disposeAll()
})

describe("memory routes", () => {
  function app() {
    return new Hono().route("/memory", MemoryRoutes())
  }

  test("reads and updates memory through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initial = await app().request("/memory")
        expect(initial.status).toBe(200)
        expect(await initial.json()).toMatchObject({ disabled: false, status: "ok" })

        const content = "# PawWork Memory\n\n## Profile\n\n- PawWork Memory is enabled.\n\n## Archive\n\n### First id:first\n\nStored note.\n"
        const updated = await app().request("/memory", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        })
        expect(updated.status).toBe(200)
        expect(await updated.json()).toMatchObject({ content })

        const disabled = await app().request("/memory/disabled", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: true }),
        })
        expect(disabled.status).toBe(200)
        expect(await disabled.json()).toMatchObject({ disabled: true })

        const deleted = await app().request("/memory/entry/first", { method: "DELETE" })
        expect(deleted.status).toBe(200)
        expect((await deleted.json()).content).not.toContain("Stored note.")
      },
    })
  })

  test("PATCH with invalid content returns a clean safe-mode reason", async () => {
    await using tmp = await tmpdir({ git: true })
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/memory", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "garbage with no profile or archive sections" }),
        })

        expect(response.status).toBe(400)
        const body = await response.json()
        // The original error must surface cleanly through the Effect runtime,
        // not as a wrapped FiberFailure trace.
        expect(body).toMatchObject({ error: "invalid_memory_file", reason: "missing_profile" })
      },
    })
  })
})
