import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { todoDisplaySignature, todoLifecycleSignature, todoPhase } from "./todo-model"

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

const idlessTodo = (
  content: string,
  status: Todo["status"] = "pending",
  priority: Todo["priority"] = "medium",
): Pick<Todo, "content" | "status" | "priority"> => ({
  content,
  status,
  priority,
})

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

describe("todoLifecycleSignature", () => {
  test("ignores content and priority refreshes", () => {
    expect(todoLifecycleSignature([todo("first", "completed", "high", "todo_1")])).toBe(
      todoLifecycleSignature([todo("first refreshed", "completed", "low", "todo_1")]),
    )
  })

  test("changes when status or count changes", () => {
    expect(todoLifecycleSignature([todo("first", "completed")])).not.toBe(
      todoLifecycleSignature([todo("first", "pending")]),
    )
    expect(todoLifecycleSignature([todo("first", "completed")])).not.toBe(
      todoLifecycleSignature([todo("first", "completed"), todo("second", "completed")]),
    )
  })

  test("changes when stable ids change with the same statuses", () => {
    expect(todoLifecycleSignature([todo("first", "pending", "medium", "todo_1")])).not.toBe(
      todoLifecycleSignature([todo("second", "pending", "medium", "todo_2")]),
    )
  })

  test("falls back to status-only signatures when ids are missing", () => {
    expect(todoLifecycleSignature([idlessTodo("first", "completed", "high")])).toBe(
      todoLifecycleSignature([idlessTodo("first refreshed", "completed", "low")]),
    )
  })

  test("falls back to status-only signatures when any todo is missing an id", () => {
    expect(
      todoLifecycleSignature([todo("first", "pending", "medium", "todo_1"), idlessTodo("second", "completed")]),
    ).toBe(
      todoLifecycleSignature([
        todo("first refreshed", "pending", "low", "todo_2"),
        idlessTodo("second refreshed", "completed"),
      ]),
    )
  })
})

describe("todoDisplaySignature", () => {
  test("tracks content, priority, and status for rendering-sensitive comparisons", () => {
    expect(todoDisplaySignature([todo("first", "completed", "high")])).not.toBe(
      todoDisplaySignature([todo("first refreshed", "completed", "high")]),
    )
    expect(todoDisplaySignature([todo("first", "completed", "high")])).not.toBe(
      todoDisplaySignature([todo("first", "completed", "low")]),
    )
  })

  test("does not collide when todo content contains old delimiter characters", () => {
    expect(todoDisplaySignature([todo("a\u0001completed\u0000medium\u0000b", "completed")])).not.toBe(
      todoDisplaySignature([todo("a", "completed"), todo("b", "completed")]),
    )
  })
})
