import { describe, expect, test } from "bun:test"
import { createBodyInteractionLock } from "./resize-handle"

describe("createBodyInteractionLock", () => {
  test("releases body interaction styles on fallback stop events", () => {
    const target = new EventTarget()
    const body = { style: { userSelect: "", overflow: "" } }
    const lock = createBodyInteractionLock(body, { target, fallbackMs: 1000 })

    lock.start()
    expect(body.style.userSelect).toBe("none")
    expect(body.style.overflow).toBe("hidden")

    target.dispatchEvent(new Event("blur"))

    expect(body.style.userSelect).toBe("")
    expect(body.style.overflow).toBe("")
  })
})
