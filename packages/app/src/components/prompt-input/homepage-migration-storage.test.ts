import { describe, expect, test } from "bun:test"
import type { Platform } from "@/context/platform"
import { createMigrationStorageIO } from "./homepage-migration-storage"

// Build a minimal desktop Platform fixture that routes get/set/remove through
// a single in-memory store with controllable async behaviour for removeItem.
function makeDesktopPlatform(input: {
  removeItem: (key: string) => Promise<void>
  initial?: Record<string, string>
}): Platform {
  const data = new Map(Object.entries(input.initial ?? {}))
  const storage = (_name?: string) => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: input.removeItem,
  })
  return {
    platform: "desktop",
    storage,
  } as unknown as Platform
}

describe("createMigrationStorageIO.remove", () => {
  test("awaits desktop async removeItem and rejects when it does", async () => {
    const error = new Error("disk full")
    const io = createMigrationStorageIO(
      makeDesktopPlatform({
        removeItem: () => Promise.reject(error),
      }),
    )

    await expect(io.remove({ storage: "ws", key: "k" })).rejects.toBe(error)
  })

  test("awaits desktop async removeItem and resolves when it does", async () => {
    const removed: string[] = []
    const io = createMigrationStorageIO(
      makeDesktopPlatform({
        removeItem: async (key) => {
          removed.push(key)
        },
      }),
    )

    await io.remove({ storage: "ws", key: "k" })
    expect(removed).toEqual(["k"])
  })
})
