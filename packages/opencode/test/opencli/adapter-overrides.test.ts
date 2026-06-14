import { describe, expect, test } from "bun:test"
import { buildAskResult } from "../../src/opencli/adapter-overrides/xiaohongshu-ask"

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
})
