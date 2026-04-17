import { describe, expect, test } from "bun:test"
import { loadReleaseHighlights } from "./highlights"

describe("loadReleaseHighlights (GitHub Releases API)", () => {
  test("synthesizes a single PawWork highlight from the release body", () => {
    const payload = [
      {
        tag_name: "v0.2.3",
        name: "v0.2.3",
        body: "Fixed first-message crash\n- bumped Minimax-M2.5\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.3", "0.2.2")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({
      title: "PawWork v0.2.3",
      description: "Fixed first-message crash",
    })
  })

  test("skips markdown headings and strips bullet markers on the first summary line", () => {
    const payload = [
      {
        tag_name: "v0.3.0",
        body: "## Desktop\n\n- Added dark theme\n- Fixed dock icon\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.3.0", "0.2.3")
    expect(highlights[0].description).toBe("Added dark theme")
  })

  test("truncates long summaries with an ellipsis", () => {
    const long = "a".repeat(300)
    const payload = [{ tag_name: "v1.0.0", body: long }]
    const highlights = loadReleaseHighlights(payload, "1.0.0", "0.9.0")
    expect(highlights[0].description.endsWith("…")).toBe(true)
    expect(highlights[0].description.length).toBe(201)
  })

  test("returns no highlights when the body is empty or only headings", () => {
    const payload = [{ tag_name: "v0.2.4", body: "# Title only\n\n## Heading only\n" }]
    expect(loadReleaseHighlights(payload, "0.2.4", "0.2.3")).toHaveLength(0)
  })

  test("keeps backward compatibility with the structured highlights schema", () => {
    const payload = [
      {
        tag: "v0.2.5",
        highlights: [
          {
            source: "desktop",
            items: [{ title: "Card Title", description: "Card Description" }],
          },
        ],
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.5", "0.2.4")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({ title: "Card Title", description: "Card Description" })
  })
})
