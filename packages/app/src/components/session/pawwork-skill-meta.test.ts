import { describe, expect, test } from "bun:test"
import { getPawworkSkillMeta, pawworkSkillCards } from "./pawwork-skill-meta"

describe("pawwork skill cards", () => {
  test("exports exactly three hardcoded Day 1 cards", () => {
    expect(pawworkSkillCards.map((item) => item.name)).toEqual([
      "document-processing",
      "data-analysis",
      "writing-assistant",
    ])
  })

  test("resolves sidebar badge metadata by skill name", () => {
    const meta = getPawworkSkillMeta("document-processing")
    expect(meta).toBeDefined()
    expect(meta!.name).toBe("document-processing")
    expect(typeof meta!.iconName).toBe("string")
    expect(getPawworkSkillMeta("missing-skill")).toBeUndefined()
  })
})
