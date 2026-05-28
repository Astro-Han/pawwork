import { describe, expect, test } from "bun:test"
import { AutomationID } from "../../src/automation"
import { Identifier } from "../../src/id/id"
import { MessageID } from "../../src/session/schema"

describe("MessageID ordering", () => {
  test("MessageID.ascending is lexicographically monotonic", () => {
    const older = MessageID.ascending(Identifier.create("message", false, 1_700_000_000_000))
    const newer = MessageID.ascending(Identifier.create("message", false, 1_700_000_000_001))

    expect(older < newer).toBe(true)
  })

  test("descending identifiers sort in the opposite direction", () => {
    const older = Identifier.create("message", true, 1_700_000_000_000)
    const newer = Identifier.create("message", true, 1_700_000_000_001)

    expect(older > newer).toBe(true)
  })

  test("timestamp supports identifiers whose prefix contains underscores", () => {
    const timestamp = 1_700_000_000
    const runID = AutomationID.Run.ascending(Identifier.create("automation_run", false, timestamp))

    expect(Identifier.timestamp(runID)).toBe(timestamp)
  })

  test("automation definition and run id schemas do not overlap", () => {
    const runID = AutomationID.Run.ascending()

    expect(AutomationID.Run.zod.safeParse(runID).success).toBe(true)
    expect(AutomationID.Definition.zod.safeParse(runID).success).toBe(false)
    expect(() => AutomationID.Definition.ascending(runID)).toThrow()
  })
})
