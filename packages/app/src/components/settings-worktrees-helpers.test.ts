import { expect, test } from "bun:test"
import { errorText } from "./settings-worktrees-helpers"

test("errorText falls back safely for circular payloads", () => {
  const circular: { self?: unknown } = {}
  circular.self = circular

  expect(errorText(circular)).toBe("[object Object]")
})

test("errorText avoids empty JSON object fallback", () => {
  expect(errorText({})).toBe("[object Object]")
})
