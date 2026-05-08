import { describe, expect, test, beforeEach } from "bun:test"
import { recordDraftEdit, consumeCarryOver, clearCarryOver, _peekLastTouched } from "./draft-carryover"

describe("draft carry-over", () => {
  beforeEach(() => clearCarryOver())

  test("recording empty text clears the pointer", () => {
    recordDraftEdit("/a", { text: "hi" })
    recordDraftEdit("/a", { text: "" })
    expect(_peekLastTouched()).toBeNull()
  })

  test("consume returns the previous dir's snapshot when target is empty", () => {
    recordDraftEdit("/a", { text: "hello" })
    const carry = consumeCarryOver("/b", true)
    expect(carry?.text).toBe("hello")
  })

  test("consume returns null when target is non-empty (no overwrite of existing draft)", () => {
    recordDraftEdit("/a", { text: "hello" })
    const carry = consumeCarryOver("/b", false)
    expect(carry).toBeNull()
  })

  test("consume returns null when target dir matches the source dir (no self-carry)", () => {
    recordDraftEdit("/a", { text: "hello" })
    expect(consumeCarryOver("/a", true)).toBeNull()
  })

  test("consume is one-shot: second call does not re-deliver", () => {
    recordDraftEdit("/a", { text: "hello" })
    expect(consumeCarryOver("/b", true)?.text).toBe("hello")
    expect(consumeCarryOver("/c", true)).toBeNull()
  })

  test("recordDraftEdit ignores empty directory", () => {
    recordDraftEdit("", { text: "hi" })
    expect(_peekLastTouched()).toBeNull()
  })
})
