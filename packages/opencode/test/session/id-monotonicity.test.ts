import { describe, expect, test } from "bun:test"
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
})
