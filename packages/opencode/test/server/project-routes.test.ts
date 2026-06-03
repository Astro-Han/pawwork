import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { ProjectRoutes } from "../../src/server/instance/project"
import { ErrorMiddleware } from "../../src/server/middleware"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("project routes", () => {
  function app() {
    return new Hono().route("/project", ProjectRoutes()).onError(ErrorMiddleware)
  }

  test("PATCH /:projectID returns documented 404 when the project does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/project/nonexistent-project-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Should Fail" }),
        })
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.name).toBe("NotFoundError")
        expect(body.data.message).toContain("Project not found: nonexistent-project-id")
      },
    })
  })
})
