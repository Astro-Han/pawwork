import { describe, expect, test } from "bun:test"
import { Truncate } from "../../src/tool/truncate"
import { withNotes } from "../../src/tool/browser-shared"
import { formatOpenCliSearchOutput } from "../../src/tool/opencli-search"
import { highRiskSiteNotice } from "../../src/tool/high-risk-site"

// Tool output is truncated head-first (truncate.ts: keep the first maxLines
// lines, capped at maxBytes, drop the tail). A high-risk caution must therefore
// LEAD the output, or it is silently cut on exactly the large, high-risk pages
// that matter. These pin that the caution lands inside the preserved head.
function headWindow(text: string): string {
  const byLines = text.split("\n").slice(0, Truncate.MAX_LINES).join("\n")
  return Buffer.from(byLines, "utf-8").subarray(0, Truncate.MAX_BYTES).toString("utf-8")
}

const CAUTION = "anti-automation risk control"

describe("high-risk caution survives head-first truncation", () => {
  test("withNotes leads with the caution; a body over both limits can't bury it", () => {
    const notice = highRiskSiteNotice("xiaohongshu.com")
    expect(notice).not.toBeNull()
    // A body larger than both the byte and line ceilings — like a full snapshot
    // or extracted page text of a content-heavy page.
    const hugeBody = Array.from({ length: Truncate.MAX_LINES + 500 }, () => "x".repeat(200)).join("\n")
    const out = withNotes({ takeoverReloaded: false, highRiskNotice: notice }, hugeBody)
    expect(Buffer.byteLength(out, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
    expect(out.split("\n").length).toBeGreaterThan(Truncate.MAX_LINES)
    expect(headWindow(out)).toContain(CAUTION)
  })

  test("opencli_search leads with the caution, ahead of the result body", () => {
    const out = formatOpenCliSearchOutput([
      { name: "xhs-post", description: "post a note", access: "write", browser: true, domain: "xiaohongshu.com", args: [] } as never,
    ])
    expect(out).toContain(CAUTION)
    expect(out.indexOf(CAUTION)).toBeLessThan(out.indexOf("xhs-post"))
  })
})
