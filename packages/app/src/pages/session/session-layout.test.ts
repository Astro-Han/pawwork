import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStableLayoutMemo } from "./session-layout"

describe("createStableLayoutMemo", () => {
  test("reuses the last value when a disposed memo turns empty", () => {
    let view = { sidePanel: { opened: true } } as { sidePanel: { opened: boolean } } | undefined

    const current = createRoot((dispose) => {
      const accessor = createStableLayoutMemo(() => view as { sidePanel: { opened: boolean } })
      accessor()
      dispose()
      return accessor
    })

    view = undefined

    expect(current()).toEqual({ sidePanel: { opened: true } })
  })

  test("throws when read before any value has been cached", () => {
    const current = createRoot((dispose) => {
      const accessor = createStableLayoutMemo(() => undefined as unknown as { sidePanel: { opened: boolean } })
      dispose()
      return accessor
    })

    expect(() => current()).toThrow("Stable layout memo read before initialization")
  })
})
