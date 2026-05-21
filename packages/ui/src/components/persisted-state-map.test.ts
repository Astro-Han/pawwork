import { expect, test } from "bun:test"
import { createBoundedStateMap } from "./persisted-state-map"

test("bounded state map caps entries and evicts the least recently used key", () => {
  const state = createBoundedStateMap<string>(2)

  state.set("oldest", "old")
  state.set("recent", "new")
  expect(state.get("oldest")).toBe("old")

  state.set("newest", "next")

  expect(state.size).toBe(2)
  expect(state.get("recent")).toBeUndefined()
  expect(state.get("oldest")).toBe("old")
  expect(state.get("newest")).toBe("next")
})
