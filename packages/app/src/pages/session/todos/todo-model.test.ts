import { describe, expect, test } from "bun:test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { todoDisplaySignature, todoLifecycleSignature, todoPhase } from "./todo-model"

const todo = (content: string, status: Todo["status"] = "pending", priority: Todo["priority"] = "medium"): Todo => ({
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
    expect(todoLifecycleSignature([todo("first", "completed", "high")])).toBe(
      todoLifecycleSignature([todo("first refreshed", "completed", "low")]),
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
})
