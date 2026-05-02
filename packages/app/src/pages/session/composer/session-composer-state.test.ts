import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { refetchPendingQuestions, todoCompletionSignature } from "./session-composer-state-helpers"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("refetchPendingQuestions", () => {
  test("retries when the running question tool appears before the pending question is listed", async () => {
    const pending = question("q-late", "root")
    let attempts = 0
    const applied: Record<string, QuestionRequest[] | undefined> = {}

    await refetchPendingQuestions({
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

    expect(attempts).toBe(2)
    expect(applied.root?.map((item) => item.id)).toEqual(["q-late"])
  })
})

describe("todoCompletionSignature", () => {
  test("ignores terminal todo content refreshes while preserving status changes", () => {
    const completed = [
      { content: "first task", status: "completed", priority: "high" },
      { content: "second task", status: "completed", priority: "medium" },
      { content: "third task", status: "completed", priority: "medium" },
      { content: "fourth task", status: "completed", priority: "low" },
    ] as const

    expect(todoCompletionSignature([...completed])).toBe(
      todoCompletionSignature([
        { ...completed[0], content: "first task done" },
        { ...completed[1], content: "second task done" },
        { ...completed[2], content: "third task done" },
        { ...completed[3], content: "fourth task done" },
      ]),
    )
    expect(todoCompletionSignature([...completed])).not.toBe(
      todoCompletionSignature([{ ...completed[0], status: "pending" }, ...completed.slice(1)]),
    )
  })
})
