import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { blurActiveElementInside } from "./session-turn-focus"

let registeredDom = false

beforeAll(() => {
  if (typeof document === "undefined" || typeof window === "undefined") {
    GlobalRegistrator.register()
    registeredDom = true
  }
})

beforeEach(() => {
  document.body.textContent = ""
})

afterAll(() => {
  if (registeredDom) GlobalRegistrator.unregister()
})

describe("blurActiveElementInside", () => {
  test("blurs the focused descendant before its ancestor is hidden from assistive tech", () => {
    const container = document.createElement("div")
    const button = document.createElement("button")
    button.textContent = "Copy"
    container.append(button)
    document.body.append(container)

    button.focus()

    expect(document.activeElement).toBe(button)
    expect(blurActiveElementInside(container)).toBe(true)
    expect(document.activeElement).not.toBe(button)
    expect(container.contains(document.activeElement)).toBe(false)
  })

  test("leaves focus alone when the active element is outside the hidden subtree", () => {
    const container = document.createElement("div")
    const inside = document.createElement("button")
    const outside = document.createElement("button")
    container.append(inside)
    document.body.append(container, outside)

    outside.focus()

    expect(document.activeElement).toBe(outside)
    expect(blurActiveElementInside(container)).toBe(false)
    expect(document.activeElement).toBe(outside)
  })

  test("handles a missing subtree", () => {
    expect(blurActiveElementInside(undefined)).toBe(false)
  })
})
