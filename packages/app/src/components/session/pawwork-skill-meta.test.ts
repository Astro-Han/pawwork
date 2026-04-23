import { describe, expect, test } from "bun:test"
import { pawworkSkillCards } from "./pawwork-skill-meta"

describe("pawworkSkillCards", () => {
  test("names are document-processing / data-analysis / writing-assistant in this order", () => {
    expect(pawworkSkillCards.map((c) => c.name)).toEqual([
      "document-processing",
      "data-analysis",
      "writing-assistant",
    ])
  })

  test("each card has the fields the home view and sidebar fallback rely on", () => {
    for (const card of pawworkSkillCards) {
      expect(card).toHaveProperty("iconName")
      expect(card).toHaveProperty("homeIcon")
      expect(card).toHaveProperty("homeIconClass")
      expect(card).toHaveProperty("titleKey")
      expect(card).toHaveProperty("descriptionKey")
    }
  })
})
