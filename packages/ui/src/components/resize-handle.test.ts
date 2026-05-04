import { describe, expect, test } from "bun:test"
import { createBodyInteractionLock } from "./resize-handle"

describe("createBodyInteractionLock", () => {
  test("releases body interaction styles on cancel events", () => {
    const target = new EventTarget()
    const body = { style: { userSelect: "", overflow: "" } }
    const releases: string[] = []
    const lock = createBodyInteractionLock(body, {
      target,
      fallbackMs: 1000,
      onRelease: (reason) => releases.push(reason),
    })

    lock.start()
    expect(body.style.userSelect).toBe("none")
    expect(body.style.overflow).toBe("hidden")

    target.dispatchEvent(new Event("blur"))

    expect(body.style.userSelect).toBe("")
    expect(body.style.overflow).toBe("")
    expect(releases).toEqual(["cancel"])
  })

  test("treats pointerup as a completed resize release", () => {
    const target = new EventTarget()
    const body = { style: { userSelect: "", overflow: "" } }
    const releases: string[] = []
    const lock = createBodyInteractionLock(body, {
      target,
      fallbackMs: 1000,
      onRelease: (reason) => releases.push(reason),
    })

    lock.start()
    target.dispatchEvent(new Event("pointerup"))

    expect(body.style.userSelect).toBe("")
    expect(body.style.overflow).toBe("")
    expect(releases).toEqual(["complete"])
  })

  test("restores previous styles and keeps repeated start idempotent", () => {
    const target = new EventTarget()
    const body = { style: { userSelect: "text", overflow: "auto" } }
    const releases: string[] = []
    const lock = createBodyInteractionLock(body, {
      target,
      fallbackMs: 1000,
      onRelease: (reason) => releases.push(reason),
    })

    lock.start()
    lock.start()
    target.dispatchEvent(new Event("mouseup"))
    target.dispatchEvent(new Event("mouseup"))

    expect(body.style.userSelect).toBe("text")
    expect(body.style.overflow).toBe("auto")
    expect(releases).toEqual(["complete"])
  })

  test("releases on timeout once", async () => {
    const target = new EventTarget()
    const body = { style: { userSelect: "", overflow: "" } }
    const releases: string[] = []
    const timeoutLock = createBodyInteractionLock(body, {
      target,
      fallbackMs: 1,
      onRelease: (reason) => releases.push(reason),
    })

    timeoutLock.start()
    expect(body.style.userSelect).toBe("none")
    expect(body.style.overflow).toBe("hidden")

    await new Promise((resolve) => setTimeout(resolve, 5))
    timeoutLock.stop()

    expect(body.style.userSelect).toBe("")
    expect(body.style.overflow).toBe("")
    expect(releases).toEqual(["timeout"])
  })
})
