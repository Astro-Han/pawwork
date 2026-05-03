import { describe, expect, test } from "bun:test"
import { createQuestionRefetchRunner } from "./question-refetch-runner"

describe("createQuestionRefetchRunner", () => {
  test("starts the current fallback session after another session finishes", async () => {
    let fallbackSessionID: string | undefined = "a"
    const started: string[] = []
    let resolveA: (() => void) | undefined

    const runner = createQuestionRefetchRunner({
      getFallbackSessionID: () => fallbackSessionID,
      queue: (callback) => callback(),
      refetch: async (sessionID) => {
        started.push(sessionID)
        if (sessionID === "a") {
          await new Promise<void>((resolve) => {
            resolveA = resolve
          })
        }
        return false
      },
    })

    runner.start("a")
    fallbackSessionID = "b"
    runner.start("b")
    expect(started).toEqual(["a", "b"])

    resolveA?.()
    await Promise.resolve()

    expect(started).toEqual(["a", "b"])
  })

  test("retries the current fallback when it was skipped by a global inflight gate", async () => {
    let fallbackSessionID: string | undefined = "a"
    const started: string[] = []
    let resolveA: (() => void) | undefined

    const runner = createQuestionRefetchRunner({
      getFallbackSessionID: () => fallbackSessionID,
      queue: (callback) => callback(),
      refetch: async (sessionID) => {
        started.push(sessionID)
        if (sessionID === "a") {
          await new Promise<void>((resolve) => {
            resolveA = resolve
          })
        }
        return false
      },
    })

    runner.start("a")
    fallbackSessionID = "b"

    resolveA?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(started).toEqual(["a", "b"])
  })

  test("does not queue another refetch after disposal", async () => {
    let fallbackSessionID: string | undefined = "a"
    const started: string[] = []
    let resolveA: (() => void) | undefined

    const runner = createQuestionRefetchRunner({
      getFallbackSessionID: () => fallbackSessionID,
      queue: (callback) => callback(),
      refetch: async (sessionID) => {
        started.push(sessionID)
        await new Promise<void>((resolve) => {
          resolveA = resolve
        })
        return false
      },
    })

    runner.start("a")
    fallbackSessionID = "b"
    runner.dispose()
    resolveA?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(started).toEqual(["a"])
  })
})
