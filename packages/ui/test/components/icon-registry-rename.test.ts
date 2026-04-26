import { describe, expect, test } from "bun:test"
import { icons } from "../../src/components/icon"

describe("icon registry agent rename (#128)", () => {
  test("agent key exists in icon registry", () => {
    expect(Object.keys(icons)).toContain("agent")
  })

  test("legacy task key does not exist in icon registry", () => {
    expect(Object.keys(icons)).not.toContain("task")
  })

  test("agent svg content is non-empty", () => {
    expect((icons as Record<string, string>).agent).toMatch(/<g[\s>]/)
  })
})
