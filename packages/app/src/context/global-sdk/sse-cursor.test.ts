import { describe, expect, test } from "bun:test"
import { createSseCursor } from "./sse-cursor"

describe("createSseCursor", () => {
  test("starts without a cursor", () => {
    const cursor = createSseCursor()
    expect(cursor.current()).toBeUndefined()
    expect(cursor.headers()).toBeUndefined()
  })

  test("stores the latest non-empty event id", () => {
    const cursor = createSseCursor()
    cursor.update(undefined)
    cursor.update("")
    cursor.update("boot:1")
    cursor.update("boot:2")

    expect(cursor.current()).toBe("boot:2")
  })

  test("builds Last-Event-ID headers when a cursor exists", () => {
    const cursor = createSseCursor()
    cursor.update("boot:7")

    const headers = cursor.headers()

    expect(headers).toBeInstanceOf(Headers)
    expect(headers?.get("Last-Event-ID")).toBe("boot:7")
  })

  test("allows e2e tests to override the cursor", () => {
    const cursor = createSseCursor()
    cursor.update("boot:7")
    cursor.setCursorForTest("bad:999")
    expect(cursor.current()).toBe("bad:999")

    cursor.setCursorForTest(undefined)
    expect(cursor.current()).toBeUndefined()
    expect(cursor.headers()).toBeUndefined()
  })
})
