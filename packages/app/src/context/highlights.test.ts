import { describe, expect, test } from "bun:test"
import { loadReleaseHighlights } from "./highlights"

describe("loadReleaseHighlights (GitHub Releases API)", () => {
  test("reads the app-facing update notice section from the release body", () => {
    const payload = [
      {
        tag_name: "v0.2.3",
        name: "v0.2.3",
        body: "## Downloads\n\n- [macOS](https://example.com/app.dmg)\n\n## App Update Notice\n\nFixed first-message crash\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.3", "0.2.2", "en")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({
      title: "PawWork v0.2.3",
      description: "Fixed first-message crash",
    })
  })

  test("prefers the Chinese update notice for zh locale", () => {
    const payload = [
      {
        tag_name: "v0.2.10",
        body: [
          "## App Update Notice",
          "",
          "- Fixed first-message crash",
          "",
          "## 中文版本",
          "",
          "### 主要更新",
          "",
          "- 修复首条消息崩溃",
          "- 调整更新提示",
        ].join("\n"),
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.10", "0.2.9", "zh")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({
      title: "爪印 v0.2.10",
      description: "修复首条消息崩溃",
    })
  })

  test("falls back to bullets directly under 中文版本 when 主要更新 is absent", () => {
    const payload = [
      {
        tag_name: "v0.2.10",
        body: ["## App Update Notice", "", "- Fixed first-message crash", "", "## 中文版本", "", "- 修复首条消息崩溃", "- 调整更新提示"].join("\n"),
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.10", "0.2.9", "zh")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({
      title: "爪印 v0.2.10",
      description: "修复首条消息崩溃",
    })
  })

  test("falls back to the English update notice when Chinese summary is missing", () => {
    const payload = [
      {
        tag_name: "v0.2.10",
        body: "## App Update Notice\n\n- Fixed first-message crash\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.10", "0.2.9", "zh")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({
      title: "爪印 v0.2.10",
      description: "Fixed first-message crash",
    })
  })

  test("skips markdown headings and strips bullet markers inside the app update notice section", () => {
    const payload = [
      {
        tag_name: "v0.3.0",
        body: "## Downloads\n\n- [macOS](https://example.com/app.dmg)\n\n## App Update Notice\n\n### Desktop\n\n- Added dark theme\n- Fixed dock icon\n\n## Verification\n\n- CI passed\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.3.0", "0.2.3", "en")
    expect(highlights[0].description).toBe("Added dark theme")
  })

  test("truncates long summaries with an ellipsis", () => {
    const long = "a".repeat(300)
    const payload = [{ tag_name: "v1.0.0", body: `## App Update Notice\n\n${long}` }]
    const highlights = loadReleaseHighlights(payload, "1.0.0", "0.9.0", "en")
    expect(highlights[0].description.endsWith("…")).toBe(true)
    expect(highlights[0].description.length).toBe(201)
  })

  test("does not guess from downloads when the app update notice section is missing", () => {
    const payload = [
      {
        tag_name: "v0.2.6",
        body: "## Downloads\n\n- [macOS Apple Silicon](https://github.com/Astro-Han/pawwork/releases/download/v0.2.6/pawwork-mac-arm64.dmg)\n\n## Highlights\n\n- Maintenance fixes\n",
      },
    ]
    expect(loadReleaseHighlights(payload, "0.2.6", "0.2.5", "en")).toHaveLength(0)
  })

  test("stops app update notice parsing at empty same-level headings", () => {
    const payload = [
      {
        tag_name: "v0.2.6",
        body: "## App Update Notice\n\n- Fixed update notices\n\n##\n\n- [macOS](https://example.com/app.dmg)\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.6", "0.2.5", "en")
    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe("Fixed update notices")
  })

  test("returns no highlights when the body is empty or only headings", () => {
    const payload = [{ tag_name: "v0.2.4", body: "# Title only\n\n## Heading only\n" }]
    expect(loadReleaseHighlights(payload, "0.2.4", "0.2.3", "en")).toHaveLength(0)
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
    const highlights = loadReleaseHighlights(payload, "0.2.5", "0.2.4", "zh")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({ title: "Card Title", description: "Card Description" })
  })

  test("does not rewrite structured highlight titles for zh locale", () => {
    const payload = [
      {
        tag: "v0.2.5",
        highlights: [
          {
            source: "desktop",
            items: [{ title: "PawWork card", description: "Card Description" }],
          },
        ],
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.5", "0.2.4", "zh")
    expect(highlights[0]?.title).toBe("PawWork card")
  })
})
