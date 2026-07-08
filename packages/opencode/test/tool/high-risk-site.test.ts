import { describe, expect, test } from "bun:test"
import { highRiskCommandNotice, highRiskSiteNotice } from "../../src/tool/high-risk-site"

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
      // Bare host with a port, query, path, or protocol-relative prefix all
      // resolve to the same hostname and must still match.
      "xiaohongshu.com:443",
      "xiaohongshu.com?x=1",
      "xiaohongshu.com/explore",
      "//xiaohongshu.com/path",
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

describe("highRiskCommandNotice", () => {
  test("flags a command whose high-risk target is only in navigateBefore", () => {
    expect(
      highRiskCommandNotice({ domain: null, navigateBefore: "https://www.xiaohongshu.com/login" }),
    ).toContain("anti-automation risk control")
    expect(highRiskCommandNotice({ domain: "xiaohongshu.com" })).toContain("anti-automation risk control")
  })

  test("returns null when neither domain nor navigateBefore is high-risk", () => {
    expect(highRiskCommandNotice({ domain: "example.com", navigateBefore: "https://example.com/x" })).toBeNull()
    expect(highRiskCommandNotice({ domain: null })).toBeNull()
    expect(highRiskCommandNotice({})).toBeNull()
  })
})
