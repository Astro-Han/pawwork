import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { refetchPendingQuestionsForSession } from "./question-reconcile"

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

describe("refetchPendingQuestionsForSession", () => {
  test("retries until the target session question appears", async () => {
    const pending = question("q-late", "root")
    let attempts = 0
    const applied: Record<string, QuestionRequest[] | undefined> = {}

    const result = await refetchPendingQuestionsForSession({
      sessionID: "root",
      maxAttempts: 2,
      delayMs: 1,
      sleep: async () => {},
      shouldContinue: () => true,
      list: async () => {
        attempts += 1
        return attempts === 1 ? [] : [pending]
      },
      apply(sessionID, questions) {
        applied[sessionID] = questions
      },
    })

    expect(result).toBe(true)
    expect(attempts).toBe(2)
    expect(applied.root?.map((item) => item.id)).toEqual(["q-late"])
  })

  test("does not stop when another session has a pending question first", async () => {
    let attempts = 0
    const applied: Record<string, QuestionRequest[] | undefined> = {}

    const result = await refetchPendingQuestionsForSession({
      sessionID: "target",
      maxAttempts: 2,
      delayMs: 1,
      sleep: async () => {},
      shouldContinue: () => true,
      list: async () => {
        attempts += 1
        return attempts === 1 ? [question("q-other", "other")] : [question("q-target", "target")]
      },
      apply(sessionID, questions) {
        applied[sessionID] = questions
      },
    })

    expect(result).toBe(true)
    expect(applied.other).toBeUndefined()
    expect(applied.target?.map((item) => item.id)).toEqual(["q-target"])
  })

  test("does not apply stale results when continuation becomes false after list", async () => {
    let shouldContinue = true
    const applied: QuestionRequest[] = []

    const result = await refetchPendingQuestionsForSession({
      sessionID: "root",
      maxAttempts: 1,
      shouldContinue: () => shouldContinue,
      list: async () => {
        shouldContinue = false
        return [question("q-root", "root")]
      },
      apply(_sessionID, questions) {
        applied.push(...questions)
      },
    })

    expect(result).toBe(false)
    expect(applied).toEqual([])
  })

  test("filters invalid questions and sorts by id before apply", async () => {
    const applied: Record<string, QuestionRequest[] | undefined> = {}

    const result = await refetchPendingQuestionsForSession({
      sessionID: "root",
      maxAttempts: 1,
      shouldContinue: () => true,
      list: async () => [question("q-b", "root"), { id: "broken" } as QuestionRequest, question("q-a", "root")],
      apply(sessionID, questions) {
        applied[sessionID] = questions
      },
    })

    expect(result).toBe(true)
    expect(applied.root?.map((item) => item.id)).toEqual(["q-a", "q-b"])
  })

  test("returns false when max attempts are reached", async () => {
    expect(
      await refetchPendingQuestionsForSession({
        sessionID: "root",
        maxAttempts: 2,
        delayMs: 1,
        sleep: async () => {},
        shouldContinue: () => true,
        list: async () => [],
        apply() {},
      }),
    ).toBe(false)
  })
})
