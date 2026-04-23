import { describe, expect, test } from "bun:test"
import { feedbackFormUrl, normalizeFeedbackFormUrl } from "./support-links"

describe("support links", () => {
  test("keeps only valid https feedback form URLs", () => {
    expect(normalizeFeedbackFormUrl(" https://example.com/form ")).toBe("https://example.com/form")
    expect(normalizeFeedbackFormUrl("http://example.com/form")).toBe("")
    expect(normalizeFeedbackFormUrl("not a url")).toBe("")
    expect(normalizeFeedbackFormUrl("")).toBe("")
  })

  test("uses the runtime feedback URL when the build-time value is empty", () => {
    expect(feedbackFormUrl("", "https://example.com/runtime-form")).toBe("https://example.com/runtime-form")
    expect(feedbackFormUrl("https://example.com/build-form", "https://example.com/runtime-form")).toBe(
      "https://example.com/build-form",
    )
  })
})
