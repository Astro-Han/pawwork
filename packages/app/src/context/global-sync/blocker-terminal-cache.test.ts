import { describe, expect, test } from "bun:test"
import { createBlockerTerminalCache } from "./blocker-terminal-cache"

describe("createBlockerTerminalCache", () => {
  test("marks and finds terminal blocker ids by kind, directory, session, and request", () => {
    const cache = createBlockerTerminalCache({ now: () => 1000 })

    cache.mark("question", "/repo", "ses_1", "q1")

    expect(cache.has("question", "/repo", "ses_1", "q1")).toBe(true)
    expect(cache.has("permission", "/repo", "ses_1", "q1")).toBe(false)
    expect(cache.has("question", "/other", "ses_1", "q1")).toBe(false)
    expect(cache.has("question", "/repo", "ses_2", "q1")).toBe(false)
  })

  test("expires old entries by ttl", () => {
    let now = 1000
    const cache = createBlockerTerminalCache({ ttlMs: 100, now: () => now })

    cache.mark("question", "/repo", "ses_1", "q1")
    now = 1200

    expect(cache.has("question", "/repo", "ses_1", "q1")).toBe(false)
  })

  test("prunes oldest entries by max size", () => {
    let now = 1000
    const cache = createBlockerTerminalCache({ max: 2, now: () => now })

    cache.mark("question", "/repo", "ses_1", "q1")
    now += 1
    cache.mark("question", "/repo", "ses_1", "q2")
    now += 1
    cache.mark("question", "/repo", "ses_1", "q3")

    expect(cache.has("question", "/repo", "ses_1", "q1")).toBe(false)
    expect(cache.has("question", "/repo", "ses_1", "q2")).toBe(true)
    expect(cache.has("question", "/repo", "ses_1", "q3")).toBe(true)
  })

  test("clears all entries for a directory", () => {
    const cache = createBlockerTerminalCache({ now: () => 1000 })

    cache.mark("question", "/repo", "ses_1", "q1")
    cache.mark("question", "/other", "ses_1", "q1")
    cache.clearDirectory("/repo")

    expect(cache.has("question", "/repo", "ses_1", "q1")).toBe(false)
    expect(cache.has("question", "/other", "ses_1", "q1")).toBe(true)
  })
})
