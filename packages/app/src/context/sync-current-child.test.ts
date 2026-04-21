import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createCurrentSyncChild } from "./sync"

describe("createCurrentSyncChild", () => {
  test("keeps sync child lookup usable after the provider owner is disposed", () => {
    let providerOwner = undefined as ReturnType<typeof getOwner> | undefined
    let childOwner = undefined as ReturnType<typeof getOwner> | undefined
    let calls = 0

    const current = createRoot((dispose) => {
      providerOwner = getOwner()
      const accessor = createCurrentSyncChild({
        directory: () => "/tmp/project",
        child: (directory) => {
          calls++
          expect(directory).toBe("/tmp/project")
          childOwner = getOwner()
          return [{ directory }, () => {}] as const
        },
      })
      dispose()
      return accessor
    })

    const value = createRoot((dispose) => {
      const result = current()
      dispose()
      return result
    })

    expect(value[0].directory).toBe("/tmp/project")
    expect(calls).toBe(1)
    expect(childOwner).toBeDefined()
    expect(childOwner).not.toBe(providerOwner)
  })
})
