import { describe, expect, test } from "bun:test"
import { dispatchCommand, upsertCommandRegistration } from "./command"

describe("upsertCommandRegistration", () => {
  test("replaces keyed registrations", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = upsertCommandRegistration([{ key: "layout", options: one }], { key: "layout", options: two })

    expect(next).toHaveLength(1)
    expect(next[0]?.options).toBe(two)
  })

  test("keeps unkeyed registrations additive", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = upsertCommandRegistration([{ options: one }], { options: two })

    expect(next).toHaveLength(2)
    expect(next[0]?.options).toBe(two)
    expect(next[1]?.options).toBe(one)
  })
})

describe("dispatchCommand", () => {
  test("runs the command with its source", () => {
    const sources: unknown[] = []
    dispatchCommand({ id: "one", title: "One", onSelect: (source) => sources.push(source) }, "palette")
    expect(sources).toEqual(["palette"])
  })

  test("does not run a disabled command", () => {
    const sources: unknown[] = []
    dispatchCommand({ id: "one", title: "One", disabled: true, onSelect: (source) => sources.push(source) }, "palette")
    expect(sources).toEqual([])
  })

  test("tolerates unregistered commands", () => {
    expect(() => dispatchCommand(undefined, "keybind")).not.toThrow()
  })
})
