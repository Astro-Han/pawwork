import { describe, expect, test } from "bun:test"
import { createDesktopContextStore } from "./desktop-context-store"
import type { DesktopContext } from "../preload/types"

const base: DesktopContext = {
  directory: null,
  sessionID: null,
  route: "/",
  locale: "en",
}

describe("desktop context store", () => {
  test("returns the context for the requested window", () => {
    const store = createDesktopContextStore(() => base)
    const activeSession = { directory: "/active", sessionID: "active", route: "/session/active", locale: "en" } as const
    const backgroundSession = {
      directory: "/background",
      sessionID: "background",
      route: "/session/background",
      locale: "zh",
    } as const

    store.set(1, activeSession)
    store.set(2, backgroundSession)

    expect(store.current(1)).toEqual(activeSession)
    expect(store.current(2)).toEqual(backgroundSession)
  })

  test("falls back to the most recent context when no window is focused", () => {
    const store = createDesktopContextStore(() => base)
    const context = { directory: "/last", sessionID: "last", route: "/session/last", locale: "zh" } as const

    store.set(5, context)

    expect(store.current()).toEqual(context)
  })

  test("forgets closed windows", () => {
    const store = createDesktopContextStore(() => base)
    const context = { directory: "/closed", sessionID: "closed", route: "/session/closed", locale: "en" } as const

    store.set(9, context)
    store.delete(9)

    expect(store.current(9)).toEqual(base)
  })

  test("falls back to the most recently updated remaining window", () => {
    const store = createDesktopContextStore(() => base)
    const first = { directory: "/first", sessionID: "first", route: "/session/first", locale: "en" } as const
    const second = { directory: "/second", sessionID: "second", route: "/session/second", locale: "zh" } as const
    const updatedFirst = {
      directory: "/first",
      sessionID: "first-new",
      route: "/session/first-new",
      locale: "zh",
    } as const

    store.set(1, first)
    store.set(2, second)
    store.set(1, updatedFirst)
    store.set(3, { directory: "/third", sessionID: "third", route: "/session/third", locale: "en" })
    store.delete(3)

    expect(store.current()).toEqual(updatedFirst)
  })

  test("uses the dynamic fallback when no window context is available", () => {
    let fallback = base
    const store = createDesktopContextStore(() => fallback)
    fallback = { ...base, locale: "zh" }

    expect(store.current(10)).toEqual(fallback)
    expect(store.current()).toEqual(fallback)
  })
})
