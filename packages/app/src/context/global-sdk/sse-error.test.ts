import { describe, expect, test } from "bun:test"
import { createRecoverableSseDisconnectReporter, isRecoverableSseDisconnect } from "./sse-error"

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

  test("surfaces sustained recoverable network disconnects once", () => {
    const reporter = createRecoverableSseDisconnectReporter({ reportAfter: 3 })

    expect(reporter.shouldReport(new TypeError("network error"))).toBe(false)
    expect(reporter.shouldReport({ name: "TypeError", message: "net::ERR_CONNECTION_CLOSED" })).toBe(false)
    expect(reporter.shouldReport(new TypeError("network error"))).toBe(true)
    expect(reporter.shouldReport(new TypeError("network error"))).toBe(false)
  })

  test("resets sustained disconnect reporting after a streamed event", () => {
    const reporter = createRecoverableSseDisconnectReporter({ reportAfter: 2 })

    expect(reporter.shouldReport(new TypeError("network error"))).toBe(false)
    expect(reporter.shouldReport(new TypeError("network error"))).toBe(true)

    reporter.reset()

    expect(reporter.shouldReport(new TypeError("network error"))).toBe(false)
  })

  test("keeps intentional aborts quiet through the sustained disconnect reporter", () => {
    const reporter = createRecoverableSseDisconnectReporter({ reportAfter: 1 })

    expect(reporter.shouldReport(new DOMException("Aborted", "AbortError"))).toBe(false)
  })

  test("reports non-recoverable errors immediately through the sustained disconnect reporter", () => {
    const reporter = createRecoverableSseDisconnectReporter({ reportAfter: 3 })

    expect(reporter.shouldReport(new Error("SSE failed: 500 Internal Server Error"))).toBe(true)
  })
})
