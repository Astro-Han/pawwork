import { describe, expect, test } from "bun:test"
import { decodeServerErrorText } from "./server-error"

describe("decodeServerErrorText", () => {
  test("reads the real reason from a structured provider response body", () => {
    // DeepSeek direct, account in arrears: the real reason lives in the body.
    const error = {
      name: "APIError",
      data: {
        message: "402 status code (no body)",
        statusCode: 402,
        responseBody: JSON.stringify({
          error: { message: "Insufficient Balance", code: "invalid_request_error", type: "unknown_error" },
        }),
      },
    }
    expect(decodeServerErrorText(error)).toBe("unknown_error: Insufficient Balance")
  })

  test("passes a clean message through verbatim", () => {
    const error = { name: "APIError", data: { message: "Insufficient Balance", statusCode: 402 } }
    expect(decodeServerErrorText(error)).toBe("Insufficient Balance")
  })

  test("extracts a structured message embedded in the message field (no response body)", () => {
    const error = {
      name: "UnknownError",
      data: { message: JSON.stringify({ error: { message: "rate limited" } }) },
    }
    expect(decodeServerErrorText(error)).toBe("rate limited")
  })

  test("prefers the response body over the message", () => {
    const error = {
      name: "APIError",
      data: {
        message: "Connection lost. Please check whether the last operation completed before resending.",
        responseBody: JSON.stringify({ error: { message: "Insufficient Balance" } }),
      },
    }
    expect(decodeServerErrorText(error)).toBe("Insufficient Balance")
  })

  test("returns undefined for a non-payload value", () => {
    expect(decodeServerErrorText("just a string")).toBeUndefined()
    expect(decodeServerErrorText(null)).toBeUndefined()
    expect(decodeServerErrorText(42)).toBeUndefined()
    expect(decodeServerErrorText({ name: "APIError" })).toBeUndefined()
  })

  test("falls back to the raw message when the body is unparseable", () => {
    const error = { name: "APIError", data: { message: "boom", responseBody: "not json" } }
    expect(decodeServerErrorText(error)).toBe("boom")
  })
})
