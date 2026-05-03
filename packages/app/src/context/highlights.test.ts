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

  test("prefers all Chinese update notice bullets for zh locale", () => {
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
      description: "• 修复首条消息崩溃\n• 调整更新提示",
    })
  })

  test("falls back to all bullets directly under 中文版本 when 主要更新 is absent", () => {
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
          "- 修复首条消息崩溃",
          "- 调整更新提示",
        ].join("\n"),
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.10", "0.2.9", "zh")
    expect(highlights).toHaveLength(1)
    expect(highlights[0]).toMatchObject({
      title: "爪印 v0.2.10",
      description: "• 修复首条消息崩溃\n• 调整更新提示",
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
      description: "• Fixed first-message crash",
    })
  })

  test("keeps hard-wrapped paragraph notices as one card", () => {
    const payload = [
      {
        tag_name: "v0.2.10",
        body: ["## App Update Notice", "", "Fixed first-message crash and improved", "the update notice parser."].join(
          "\n",
        ),
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.2.10", "0.2.9", "en")
    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe("Fixed first-message crash and improved the update notice parser.")
  })

  test("skips markdown headings and strips bullet markers inside the app update notice section", () => {
    const payload = [
      {
        tag_name: "v0.3.0",
        body: "## Downloads\n\n- [macOS](https://example.com/app.dmg)\n\n## App Update Notice\n\n### Desktop\n\n- Added dark theme\n- Fixed dock icon\n\n## Verification\n\n- CI passed\n",
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.3.0", "0.2.3", "en")
    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe("• Added dark theme\n• Fixed dock icon")
  })

  test("keeps wrapped bullet continuation lines", () => {
    const payload = [
      {
        tag_name: "v0.3.0",
        body: [
          "## App Update Notice",
          "",
          "- Fixed first-message crash",
          "  when startup takes longer",
          "- Added update notice parser",
        ].join("\n"),
      },
    ]
    const highlights = loadReleaseHighlights(payload, "0.3.0", "0.2.3", "en")
    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe(
      "• Fixed first-message crash when startup takes longer\n• Added update notice parser",
    )
  })

  test("keeps all localized update notice bullets", () => {
    const payload = [
      {
        tag_name: "v2026.4.29",
        body: [
          "## App Update Notice",
          "",
          "PawWork refreshes the desktop.",
          "",
          "## 中文版本",
          "",
          "### 主要更新",
          "",
          "PawWork 2026.4.29 刷新桌面界面。",
          "",
          "- 刷新桌面界面",
          "- 修复首次进入 Home 时左右侧栏默认打开的问题",
          "- 移除内置 Trash 工具",
          "- 提升 session 稳定性",
          "- 新增前台 subagent 生命周期支持",
          "- 默认启用 open permissions",
          "- 修复 Windows 拖拽上传",
        ].join("\n"),
      },
    ]
    const highlights = loadReleaseHighlights(payload, "2026.4.29", "2026.4.28", "zh")
    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe(
      "PawWork 2026.4.29 刷新桌面界面。\n• 刷新桌面界面\n• 修复首次进入 Home 时左右侧栏默认打开的问题\n• 移除内置 Trash 工具\n• 提升 session 稳定性\n• 新增前台 subagent 生命周期支持\n• 默认启用 open permissions\n• 修复 Windows 拖拽上传",
    )
  })

  test("keeps skipped-version highlights at version granularity", () => {
    const payload = [
      {
        tag_name: "v2026.4.29",
        body: "## App Update Notice\n\n- A\n- B\n- C\n",
      },
      {
        tag_name: "v2026.4.28",
        body: "## App Update Notice\n\n- D\n- E\n- F\n",
      },
    ]

    const highlights = loadReleaseHighlights(payload, "2026.4.29", "2026.4.27", "en")
    expect(highlights).toHaveLength(2)
    expect(highlights.map((highlight) => highlight.description)).toEqual(["• A\n• B\n• C", "• D\n• E\n• F"])
  })

  test("limits long skipped-version ranges to five version pages", () => {
    const payload = Array.from({ length: 6 }, (_, index) => {
      const patch = 6 - index

      return {
        tag_name: `v1.0.${patch}`,
        body: `## App Update Notice\n\n- Item ${patch}\n`,
      }
    })

    const highlights = loadReleaseHighlights(payload, "1.0.6", "1.0.0", "en")

    expect(highlights).toHaveLength(5)
    expect(highlights.map((highlight) => highlight.title)).toEqual([
      "PawWork v1.0.6",
      "PawWork v1.0.5",
      "PawWork v1.0.4",
      "PawWork v1.0.3",
      "PawWork v1.0.2",
    ])
  })

  test("does not cap bullets inside a single version page", () => {
    const payload = [
      {
        tag_name: "v1.0.0",
        body: ["## App Update Notice", "", "- Item 1", "- Item 2", "- Item 3", "- Item 4", "- Item 5", "- Item 6"].join(
          "\n",
        ),
      },
    ]

    const highlights = loadReleaseHighlights(payload, "1.0.0", "0.9.0", "en")

    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe("• Item 1\n• Item 2\n• Item 3\n• Item 4\n• Item 5\n• Item 6")
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
    expect(highlights[0].description).toBe("• Fixed update notices")
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

  test("keeps structured highlight items as separate pages", () => {
    const payload = [
      {
        tag: "v0.2.5",
        highlights: [
          {
            source: "desktop",
            items: [
              { title: "Card A", description: "Description A" },
              { title: "Card B", description: "Description B" },
            ],
          },
        ],
      },
    ]

    const highlights = loadReleaseHighlights(payload, "0.2.5", "0.2.4", "en")

    expect(highlights).toHaveLength(2)
    expect(highlights.map((highlight) => highlight.title)).toEqual(["Card A", "Card B"])
  })

  test("keeps structured highlight cap independent from release-body version cap", () => {
    const payload = [
      {
        tag: "v0.2.5",
        highlights: [
          {
            source: "desktop",
            items: Array.from({ length: 6 }, (_, index) => ({
              title: `Card ${index + 1}`,
              description: `Description ${index + 1}`,
            })),
          },
        ],
      },
    ]

    const highlights = loadReleaseHighlights(payload, "0.2.5", "0.2.4", "en")

    expect(highlights).toHaveLength(6)
    expect(highlights.map((highlight) => highlight.title)).toEqual([
      "Card 1",
      "Card 2",
      "Card 3",
      "Card 4",
      "Card 5",
      "Card 6",
    ])
  })

  test("keeps structured highlight limit at fifteen cards", () => {
    const payload = [
      {
        tag: "v0.2.5",
        highlights: [
          {
            source: "desktop",
            items: Array.from({ length: 16 }, (_, index) => ({
              title: `Card ${index + 1}`,
              description: `Description ${index + 1}`,
            })),
          },
        ],
      },
    ]

    const highlights = loadReleaseHighlights(payload, "0.2.5", "0.2.4", "en")

    expect(highlights).toHaveLength(15)
    expect(highlights.at(-1)?.title).toBe("Card 15")
  })

  test("preserves intro prose before bullets in mixed content notices", () => {
    const payload = [
      {
        tag_name: "v1.0.0",
        body: [
          "## App Update Notice",
          "",
          "Important migration note for this release.",
          "",
          "- Fixed crash on startup",
          "- Added dark mode support",
        ].join("\n"),
      },
    ]

    const highlights = loadReleaseHighlights(payload, "1.0.0", "0.9.0", "en")

    expect(highlights).toHaveLength(1)
    expect(highlights[0].description).toBe(
      "Important migration note for this release.\n• Fixed crash on startup\n• Added dark mode support",
    )
  })
})
