import { describe, expect, test } from "bun:test"
import { highRiskSiteNotice } from "../../src/tool/high-risk-site"

describe("highRiskSiteNotice", () => {
  test("flags Xiaohongshu by full URL, bare host, and subdomain", () => {
    for (const input of [
      "https://www.xiaohongshu.com/explore",
      "xiaohongshu.com",
      "www.xiaohongshu.com",
      "https://xhslink.com/abc",
      "xhslink.com",
      // A root-label trailing dot resolves to the same site; it must not slip
      // past the suffix match.
      "https://www.xiaohongshu.com./explore",
      "xiaohongshu.com.",
    ]) {
      expect(highRiskSiteNotice(input)).toContain("anti-automation risk control")
    }
  })

  test("does not flag look-alike or unrelated hosts", () => {
    for (const input of [
      "https://example.com",
      "notxiaohongshu.com",
      "https://xiaohongshu.com.evil.com/path",
      "github.com",
      "",
    ]) {
      expect(highRiskSiteNotice(input)).toBeNull()
    }
  })
})
