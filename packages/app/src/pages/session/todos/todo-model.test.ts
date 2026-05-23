import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { todoPhase, todoSnapshot } from "./todo-model"

const todo = (
  content: string,
  status: Todo["status"] = "pending",
  priority: Todo["priority"] = "medium",
  id?: string,
): Todo =>
  ({
    id,
    content,
    status,
    priority,
  }) as Todo

describe("todoPhase", () => {
  test("classifies an empty list as empty", () => {
    expect(todoPhase([])).toBe("empty")
  })

  test("classifies pending and in_progress todos as active", () => {
    expect(todoPhase([todo("queued", "pending")])).toBe("active")
    expect(todoPhase([todo("working", "in_progress")])).toBe("active")
  })

  test("classifies all completed or cancelled todos as terminal", () => {
    expect(todoPhase([todo("done", "completed"), todo("skipped", "cancelled")])).toBe("terminal")
  })
})

describe("todoSnapshot", () => {
  test("keeps status summary data without dock-only fields", () => {
    expect(
      todoSnapshot({
        sessionID: "ses_1",
        source: "primary-parts",
        items: [todo("working", "in_progress", "high", "todo_1")],
        sourceUpdatedAt: 10,
      }),
    ).toEqual({
      sessionID: "ses_1",
      source: "primary-parts",
      items: [todo("working", "in_progress", "high", "todo_1")],
      phase: "active",
      sourceUpdatedAt: 10,
    })
  })
})
