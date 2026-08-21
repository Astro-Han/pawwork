import { afterEach, describe, expect, test } from "vitest"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CI_SMOKE_V1_AUTOMATION_ID,
  CI_SMOKE_V1_BULK_SESSION_COUNT,
  CI_SMOKE_V1_SESSION_ID,
  createCiSmokeV1Fixture,
} from "./ci-smoke-v1-fixture"

const require = createRequire(import.meta.url)
const { readV1Sessions } = require("../resources/dsh/home/plugins/import-v1/import-v1.cjs")
const { readV1Automations } = require("../resources/dsh/home/plugins/import-v1/import-v1-automations.cjs")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("CI smoke v1 fixture", () => {
  test("is consumed by the production session and Automation import readers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-ci-v1-"))
    roots.push(root)
    const database = join(root, "pawwork.db")
    createCiSmokeV1Fixture(database, root)

    const sessions = []
    for await (const session of readV1Sessions(database)) sessions.push(session)
    const automations = readV1Automations(database)

    expect(sessions).toHaveLength(CI_SMOKE_V1_BULK_SESSION_COUNT + 1)
    // The bulk sessions import first; the target lands last, so the sidebar
    // assertion can prove a post-connect refresh without a reload.
    expect(sessions.slice(0, CI_SMOKE_V1_BULK_SESSION_COUNT).map((session) => session.id)).toEqual(
      Array.from({ length: CI_SMOKE_V1_BULK_SESSION_COUNT }, (_, index) => `ci-smoke-bulk-${index}`),
    )
    expect(sessions.at(-1)?.id).toBe(CI_SMOKE_V1_SESSION_ID)
    expect(automations.definitions.map((definition: { id: string }) => definition.id)).toEqual([
      CI_SMOKE_V1_AUTOMATION_ID,
    ])
  })
})
