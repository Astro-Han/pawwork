import { describe, expect, test } from "bun:test"
import { getRegistry } from "@jackwener/opencli/registry"

describe("opencli contract", () => {
  test("shares the command registry through the process global", () => {
    const globals = globalThis as typeof globalThis & { __opencli_registry__?: unknown }
    const registry = globals.__opencli_registry__

    expect(registry).toBeInstanceOf(Map)
    if (!(registry instanceof Map)) throw new Error("OpenCLI registry global is not a Map")
    expect(getRegistry()).toBe(registry)
  })
})
