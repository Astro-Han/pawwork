import { describe, expect, test } from "bun:test"
import { normalizeFeedbackFormUrl } from "./support-links"

describe("support links", () => {
  test("keeps only valid https feedback form URLs", () => {
    expect(normalizeFeedbackFormUrl(" https://example.com/form ")).toBe("https://example.com/form")
    expect(normalizeFeedbackFormUrl("http://example.com/form")).toBe("")
    expect(normalizeFeedbackFormUrl("not a url")).toBe("")
    expect(normalizeFeedbackFormUrl("")).toBe("")
  })
})
