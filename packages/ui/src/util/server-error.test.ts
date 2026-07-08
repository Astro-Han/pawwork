import { describe, expect, test } from "bun:test"
import { decodeServerErrorText } from "./server-error"

describe("decodeServerErrorText", () => {
  test("reads the real reason from a structured provider response body", () => {
    // DeepSeek direct, account in arrears: the real reason lives in the body.
    // The human message wins over the machine `type` — "Insufficient Balance",
    // not "unknown_error: Insufficient Balance".
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
    expect(decodeServerErrorText(error)).toBe("Insufficient Balance")
  })

  test("falls back to the machine type/code only when there is no message", () => {
    const error = {
      name: "APIError",
      data: { message: "x", responseBody: JSON.stringify({ error: { type: "insufficient_quota" } }) },
    }
    expect(decodeServerErrorText(error)).toBe("insufficient_quota")
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

  // P2: a bare Unknown error can hand back a display string instead of a clean
  // message + structured body — an `Error:` prefix or JSON embedded in text. The
  // decoder must still surface the real reason, not show the raw blob.
  test("strips an `Error:` prefix and decodes the embedded JSON reason", () => {
    const error = {
      name: "UnknownError",
      data: { message: 'Error: {"error":{"message":"Insufficient Balance","type":"unknown_error"}}' },
    }
    expect(decodeServerErrorText(error)).toBe("Insufficient Balance")
  })

  test("recovers a JSON error body embedded in surrounding text", () => {
    const error = {
      name: "UnknownError",
      data: { message: 'request failed {"error":{"message":"rate limited"}} (status 429)' },
    }
    expect(decodeServerErrorText(error)).toBe("rate limited")
  })

  test("leaves a plain message with no JSON object untouched (negative)", () => {
    const error = { name: "UnknownError", data: { message: "Connection lost. Please retry." } }
    expect(decodeServerErrorText(error)).toBe("Connection lost. Please retry.")
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
