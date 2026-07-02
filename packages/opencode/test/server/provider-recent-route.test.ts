import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

// The real entry path the desktop picker hits: POST /provider/recent must route,
// validate the body, and land the pick in state/model.json's `recent` — the list
// Provider.defaultModel() reads for a model-less session. Asserting through the
// live route guards the route path, the request body schema, and the handler ->
// model.json wiring all at once (the unit tests only cover ModelState directly).
const modelFile = () => path.join(Global.Path.state, "model.json")

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
  await fs.rm(modelFile(), { force: true })
})

describe("POST /provider/recent", () => {
  beforeEach(async () => {
    await fs.mkdir(Global.Path.state, { recursive: true })
    await fs.rm(modelFile(), { force: true })
  })

  test("persists the posted model to the front of model.json recent", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app

    const response = await app.request("/provider/recent", {
      method: "POST",
      headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
      body: JSON.stringify({ providerID: "deepseek", modelID: "deepseek-chat" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)

    const recent = JSON.parse(await fs.readFile(modelFile(), "utf-8")).recent
    expect(recent[0]).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
  })

  test("rejects a body missing modelID (request schema is enforced)", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app

    const response = await app.request("/provider/recent", {
      method: "POST",
      headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
      body: JSON.stringify({ providerID: "deepseek" }),
    })

    expect(response.status).toBe(400)
    // The schema rejects before the handler runs, so nothing is persisted.
    await expect(fs.access(modelFile())).rejects.toThrow()
  })
})
