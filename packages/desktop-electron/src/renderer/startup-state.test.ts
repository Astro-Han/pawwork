import { afterEach, describe, expect, test } from "bun:test"
import { createStartupState, getStartupState, pushPendingDeepLinks } from "./startup-state"

afterEach(() => {
  delete (globalThis as any).window
})

describe("desktop renderer startup state", () => {
  test("loads window config through preload IPC and consumes initial deep links once", async () => {
    const calls: string[] = []
    ;(globalThis as any).window = {
      api: {
        getWindowConfig: async () => {
          calls.push("config")
          return { updaterEnabled: true, wslEnabled: true }
        },
        consumeInitialDeepLinks: async () => {
          calls.push("links")
          return ["opencode://first"]
        },
      },
    }

    const state = createStartupState()
    await expect(state.ready).resolves.toBeUndefined()
    expect(state.updaterEnabled()).toBe(true)
    expect(state.wslEnabled()).toBe(true)
    expect(state.consumeInitialDeepLinks()).toEqual(["opencode://first"])
    expect(state.consumeInitialDeepLinks()).toEqual([])
    expect(calls).toEqual(["config", "links"])
  })

  test("falls back closed when preload startup IPC fails", async () => {
    const warn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    ;(globalThis as any).window = {
      api: {
        getWindowConfig: async () => {
          throw new Error("missing")
        },
        consumeInitialDeepLinks: async () => {
          throw new Error("missing")
        },
      },
    }

    try {
      const state = createStartupState()
      await expect(state.ready).resolves.toBeUndefined()
      expect(state.updaterEnabled()).toBe(false)
      expect(state.wslEnabled()).toBe(false)
      expect(state.consumeInitialDeepLinks()).toEqual([])
      expect(warnings[0]?.[0]).toBe("[desktop] startup IPC failed")
    } finally {
      console.warn = warn
    }
  })

  test("uses the closed fallback when preload did not expose api", async () => {
    ;(globalThis as any).window = {}

    const state = createStartupState()
    await expect(state.ready).resolves.toBeUndefined()
    expect(state.updaterEnabled()).toBe(false)
    expect(state.wslEnabled()).toBe(false)
  })

  test("buffers deep links for the app layout to drain after mount", () => {
    const target = {} as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    pushPendingDeepLinks(target, ["opencode://open-project?directory=/a"])
    pushPendingDeepLinks(target, ["opencode://new-session?directory=/b"])

    expect(target.__OPENCODE__?.deepLinks).toEqual([
      "opencode://open-project?directory=/a",
      "opencode://new-session?directory=/b",
    ])
  })

  test("does not start singleton IPC until requested", async () => {
    delete (globalThis as any).window

    const state = getStartupState()
    await expect(state.ready).resolves.toBeUndefined()
    expect(state.updaterEnabled()).toBe(false)
  })
})
