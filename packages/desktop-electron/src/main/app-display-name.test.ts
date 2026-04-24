import { describe, expect, test } from "bun:test"
import { localizedAppDisplayName } from "./app-display-name"

describe("localized app display name", () => {
  test("keeps stable English names outside zh locale", () => {
    expect(localizedAppDisplayName("PawWork", "en")).toBe("PawWork")
    expect(localizedAppDisplayName("PawWork Beta", "en")).toBe("PawWork Beta")
  })

  test("localizes stable product names for zh locale without changing identifiers", () => {
    expect(localizedAppDisplayName("PawWork", "zh")).toBe("爪印")
    expect(localizedAppDisplayName("PawWork Beta", "zh")).toBe("爪印 Beta")
    expect(localizedAppDisplayName("PawWork Dev", "zh")).toBe("爪印 Dev")
  })
})
