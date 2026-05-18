import { describe, expect, test } from "bun:test"
import { isRecoverableSseDisconnect } from "./sse-error"

describe("isRecoverableSseDisconnect", () => {
  test("treats intentional aborts as recoverable", () => {
    expect(isRecoverableSseDisconnect({ name: "AbortError" })).toBe(true)
    expect(isRecoverableSseDisconnect(new DOMException("Aborted", "AbortError"))).toBe(true)
  })

  test("treats Chromium suspended SSE network errors as recoverable", () => {
    expect(isRecoverableSseDisconnect(new TypeError("network error"))).toBe(true)
    expect(isRecoverableSseDisconnect({ name: "TypeError", message: "net::ERR_NETWORK_IO_SUSPENDED" })).toBe(true)
    expect(isRecoverableSseDisconnect({ name: "TypeError", message: "net::ERR_CONNECTION_CLOSED" })).toBe(true)
  })

  test("keeps unknown errors reportable", () => {
    expect(isRecoverableSseDisconnect(new Error("SSE failed: 500 Internal Server Error"))).toBe(false)
    expect(isRecoverableSseDisconnect({ name: "TypeError", message: "failed to parse stream chunk" })).toBe(false)
    expect(isRecoverableSseDisconnect("network error")).toBe(false)
  })
})
