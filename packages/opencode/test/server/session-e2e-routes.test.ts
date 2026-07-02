import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

const originalE2EEnabled = process.env.OPENCODE_E2E_ENABLED
const originalE2ELlmURL = process.env.OPENCODE_E2E_LLM_URL

afterEach(() => {
  if (originalE2EEnabled === undefined) delete process.env.OPENCODE_E2E_ENABLED
  else process.env.OPENCODE_E2E_ENABLED = originalE2EEnabled
  if (originalE2ELlmURL === undefined) delete process.env.OPENCODE_E2E_LLM_URL
  else process.env.OPENCODE_E2E_LLM_URL = originalE2ELlmURL
  return Instance.disposeAll()
})

describe("session e2e routes", () => {
  test("disabled update-todos route returns 404 before json validation", async () => {
    delete process.env.OPENCODE_E2E_ENABLED
    delete process.env.OPENCODE_E2E_LLM_URL

    await using tmp = await tmpdir({ git: true })
    const route = `/session/__e2e/update-todos?directory=${encodeURIComponent(tmp.path)}`
    const malformed = await Server.Default().app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    })
    const valid = await Server.Default().app.request(route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: "ses_disabled",
        todos: [],
      }),
    })

    expect(malformed.status).toBe(404)
    expect(valid.status).toBe(404)
  })
})
