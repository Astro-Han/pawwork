import { expect, test } from "bun:test"
import { basicToolInitialReady } from "./basic-tool"

test("deferred default-open tools do not mount details immediately", () => {
  expect(basicToolInitialReady({ defaultOpen: true, defer: true })).toBe(false)
})

test("non-deferred default-open tools keep the previous immediate details behavior", () => {
  expect(basicToolInitialReady({ defaultOpen: true })).toBe(true)
  expect(basicToolInitialReady({ defaultOpen: true, defer: false })).toBe(true)
})

test("closed tools start without mounted details", () => {
  expect(basicToolInitialReady({ defaultOpen: false, defer: true })).toBe(false)
  expect(basicToolInitialReady({ defaultOpen: false })).toBe(false)
  expect(basicToolInitialReady({ defer: true })).toBe(false)
  expect(basicToolInitialReady({})).toBe(false)
})
