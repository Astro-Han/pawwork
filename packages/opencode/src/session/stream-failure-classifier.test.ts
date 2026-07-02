import { describe, expect, test } from "bun:test"
import { classifyStreamFailure, classifyBareTransportMessage } from "./stream-failure-classifier"

// Every transport errno and its expected retryability. ENOTFOUND is the only
// permanent one (unresolved host); everything else is transient. Driven as a
// matrix so adding/renaming a code in TRANSPORT_CODES forces a matching row.
const TRANSPORT_CODE_MATRIX: ReadonlyArray<readonly [code: string, retryable: boolean]> = [
  ["ECONNRESET", true],
  ["ECONNREFUSED", true],
  ["ETIMEDOUT", true],
  ["ECONNABORTED", true],
  ["EPIPE", true],
  ["EHOSTUNREACH", true],
  ["ENETUNREACH", true],
  ["EAI_AGAIN", true],
  ["ENOTFOUND", false],
  ["UND_ERR_SOCKET", true],
  ["UND_ERR_CONNECT_TIMEOUT", true],
  ["UND_ERR_HEADERS_TIMEOUT", true],
  ["UND_ERR_BODY_TIMEOUT", true],
]

describe("classifyStreamFailure — transport code matrix", () => {
  for (const [code, retryable] of TRANSPORT_CODE_MATRIX) {
    test(`top-level ${code} → transport disconnect (retryable=${retryable})`, () => {
      const error = Object.assign(new Error(`failed: ${code}`), { code })
      expect(classifyStreamFailure(error)).toEqual({ kind: "provider_transport_disconnect", retryable, code })
    })

    test(`${code} nested in the cause chain → transport disconnect (retryable=${retryable})`, () => {
      const cause = Object.assign(new Error("inner"), { code })
      const error = new TypeError("fetch failed", { cause })
      expect(classifyStreamFailure(error)).toEqual({ kind: "provider_transport_disconnect", retryable, code })
    })
  }
})

describe("classifyStreamFailure — not a code-based transport error", () => {
  test("generic Error returns undefined", () => {
    expect(classifyStreamFailure(new Error("something broke"))).toBeUndefined()
  })

  test("unknown errno code returns undefined", () => {
    expect(classifyStreamFailure(Object.assign(new Error("x"), { code: "ESOMETHINGELSE" }))).toBeUndefined()
  })

  test("AbortError returns undefined", () => {
    expect(classifyStreamFailure(new DOMException("The operation was aborted", "AbortError"))).toBeUndefined()
  })

  test("non-Error values return undefined", () => {
    expect(classifyStreamFailure("string error")).toBeUndefined()
    expect(classifyStreamFailure(null)).toBeUndefined()
    expect(classifyStreamFailure(42)).toBeUndefined()
  })

  test("TypeError('terminated') without a transport-coded cause returns undefined", () => {
    expect(classifyStreamFailure(new TypeError("terminated", { cause: new Error("unrelated") }))).toBeUndefined()
  })

  test("a bare 'socket hang up' message is NOT code-classified (the bare-message fallback owns it)", () => {
    // The message fallback was moved out of classifyStreamFailure so structured
    // stream parsing can run first; the code path only matches errno codes.
    expect(classifyStreamFailure(new Error("socket hang up"))).toBeUndefined()
  })

  test("HTTP error (statusCode) with a transport-coded cause stays an API error, not transport", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" })
    const error = Object.assign(new Error("400 invalid request"), { statusCode: 400, cause })
    expect(classifyStreamFailure(error)).toBeUndefined()
  })
})

describe("classifyBareTransportMessage — anchored bare connection messages", () => {
  test("exact 'socket hang up' → retryable transport", () => {
    expect(classifyBareTransportMessage(new Error("socket hang up"))).toEqual({
      kind: "provider_transport_disconnect",
      retryable: true,
      code: "SOCKET_HANG_UP",
    })
  })

  test("exact 'premature close' (surrounding whitespace trimmed) → retryable transport", () => {
    expect(classifyBareTransportMessage(new Error("  premature close\n"))).toEqual({
      kind: "provider_transport_disconnect",
      retryable: true,
      code: "PREMATURE_CLOSE",
    })
  })

  test("a longer message that merely CONTAINS the phrase is not a bare transport error", () => {
    expect(
      classifyBareTransportMessage(new Error("invalid request: socket hang up is not allowed")),
    ).toBeUndefined()
  })

  test("an HTTP error (statusCode) whose message is exactly 'socket hang up' is not bare transport", () => {
    expect(
      classifyBareTransportMessage(Object.assign(new Error("socket hang up"), { statusCode: 502 })),
    ).toBeUndefined()
  })

  test("non-Error value and unrelated message return undefined", () => {
    expect(classifyBareTransportMessage("socket hang up")).toBeUndefined()
    expect(classifyBareTransportMessage(new Error("something else"))).toBeUndefined()
  })
})
