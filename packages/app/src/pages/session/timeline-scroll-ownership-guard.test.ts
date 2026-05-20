import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { timelineScrollCommandAllowlist } from "./timeline-scroll-command-allowlist"
import { scanTimelineScrollOwnership, scanTimelineScrollOwnershipText } from "./timeline-scroll-ownership-guard"
import { timelineScrollOwnershipFixtures } from "./timeline-scroll-ownership-fixtures"

const here = dirname(fileURLToPath(import.meta.url))

describe("timeline scroll ownership guard", () => {
  test("rejects direct and indirect timeline scroll bypasses", () => {
    const forbidden = [
      timelineScrollOwnershipFixtures.directScrollTop,
      timelineScrollOwnershipFixtures.directScrollTo,
      timelineScrollOwnershipFixtures.directScroll,
      timelineScrollOwnershipFixtures.directScrollShorthandTop,
      timelineScrollOwnershipFixtures.directScrollSpreadOptions,
      timelineScrollOwnershipFixtures.directScrollIntoView,
      timelineScrollOwnershipFixtures.helperAlias,
      timelineScrollOwnershipFixtures.computedScrollTop,
      timelineScrollOwnershipFixtures.scrollTopIncrement,
      timelineScrollOwnershipFixtures.fakeSinkAlias,
      timelineScrollOwnershipFixtures.importedUtility,
      timelineScrollOwnershipFixtures.virtualizerReveal,
    ]

    for (const [index, sourceText] of forbidden.entries()) {
      const result = scanTimelineScrollOwnershipText({ filePath: `forbidden-${index}.ts`, sourceText })
      expect(result.violations.length).toBeGreaterThan(0)
    }
  })

  test("allows sink execution and reviewed non-timeline exceptions", () => {
    expect(
      scanTimelineScrollOwnershipText({
        filePath: "allowed-sink.ts",
        sourceText: timelineScrollOwnershipFixtures.allowedSink,
      }).violations,
    ).toEqual([])

    expect(
      scanTimelineScrollOwnershipText({
        filePath: "allowed-non-timeline.ts",
        sourceText: timelineScrollOwnershipFixtures.allowedNonTimeline,
        allowlist: [
          {
            filePath: "allowed-non-timeline.ts",
            symbol: "ok",
            reason: "fixture represents a non-session scroller",
            owner: "test",
            removal: "fixture only",
          },
        ],
      }).violations,
    ).toEqual([])
  })

  test("keeps production session timeline writes behind the command sink", async () => {
    const result = await scanTimelineScrollOwnership({
      roots: [here],
      allowlist: timelineScrollCommandAllowlist,
      exclude: [
        /\.test\.tsx?$/,
        /timeline-scroll-command-sink\.ts$/,
        /timeline-scroll-command-allowlist\.ts$/,
        /timeline-scroll-ownership-guard\.ts$/,
        /timeline-scroll-ownership-fixtures\.ts$/,
        /file-tab-scroll\.ts$/,
      ],
      include: [/\.tsx?$/],
      rootLabel: join("packages", "app", "src", "pages", "session"),
    })

    expect(result.violations).toEqual([])
  })

  test("scans newly added session timeline files without a manual file list", async () => {
    const root = await mkdtemp(join(tmpdir(), "timeline-scroll-ownership-"))
    try {
      await writeFile(
        join(root, "new-session-timeline-writer.ts"),
        `
          export function bypass(viewport: HTMLElement) {
            viewport.scrollTop = 10
          }
        `,
      )

      const result = await scanTimelineScrollOwnership({
        roots: [root],
        allowlist: [],
        include: [/\.tsx?$/],
        rootLabel: join("packages", "app", "src", "pages", "session"),
      })

      expect(result.violations).toEqual([
        expect.objectContaining({
          filePath: join("packages", "app", "src", "pages", "session", "new-session-timeline-writer.ts"),
          symbol: "bypass",
          reason: "direct scrollTop write bypasses TimelineScrollCommandSink",
        }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
