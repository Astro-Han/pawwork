import { describe, expect, test } from "bun:test"
import { buildAskResult, normalizeAskSource } from "../../src/opencli/adapter-overrides/xiaohongshu-ask"

describe("OpenCLI adapter overrides", () => {
  test("strips malformed HTML-like tags from Xiaohongshu ask text", () => {
    const result = buildAskResult({
      query: "q",
      answer: "kept <script",
      message_id: "msg",
      conversation_id: "conv",
    })

    expect(result.answer).toBe("kept")
  })

  test("strips complete HTML-like tags while preserving plain less-than text", () => {
    const result = buildAskResult({
      query: "q",
      answer: "<b>kept</b> and a < b",
      message_id: "msg",
      conversation_id: "conv",
    })

    expect(result.answer).toBe("kept and a < b")
  })

  test("normalizes only trusted Xiaohongshu source links into note URLs", () => {
    const noteId = "a".repeat(24)

    expect(
      normalizeAskSource(
        {
          title: "Relative",
          textLink: `/explore/${noteId}?xsec_token=relative-token`,
        },
        0,
      ),
    ).toMatchObject({
      rank: 1,
      note_id: noteId,
      xsec_token: "relative-token",
      url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=relative-token&xsec_source=`,
    })

    expect(
      normalizeAskSource(
        {
          title: "Deep link",
          textLink: `xhsdiscover://item/${noteId}?xsec_token=deep-token`,
        },
        1,
      ),
    ).toMatchObject({
      rank: 2,
      note_id: noteId,
      xsec_token: "deep-token",
      url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=deep-token&xsec_source=`,
    })

    expect(
      normalizeAskSource(
        {
          title: "External",
          textLink: `https://www.xiaohongshu.com.evil.test/explore/${noteId}?xsec_token=bad-token`,
        },
        2,
      ),
    ).toMatchObject({
      rank: 3,
      title: "External",
      note_id: "",
      xsec_token: "",
      url: "",
    })
  })
})
