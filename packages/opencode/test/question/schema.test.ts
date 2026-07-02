import { test, expect } from "bun:test"
import { Schema } from "effect"
import { Question } from "../../src/question"

const Option = Schema.decodeUnknownSync(Question.Option)
const Prompt = Schema.decodeUnknownSync(Question.Prompt)

const validOption = { label: "ok", description: "ok" }
const validPrompt = {
  question: "ok",
  header: "ok",
  options: [validOption, validOption],
  multiple: false,
  custom: true,
}

test("Option.label rejects > 50 chars", () => {
  expect(() => Option({ label: "x".repeat(51), description: "ok" })).toThrow()
})

test("Option.label accepts exactly 50 chars", () => {
  expect(() => Option({ label: "x".repeat(50), description: "ok" })).not.toThrow()
})

test("Option.description rejects > 120 chars", () => {
  expect(() => Option({ label: "ok", description: "x".repeat(121) })).toThrow()
})

test("Option.description accepts exactly 120 chars", () => {
  expect(() => Option({ label: "ok", description: "x".repeat(120) })).not.toThrow()
})

test("Option.description rejects empty / whitespace-only", () => {
  expect(() => Option({ label: "ok", description: "" })).toThrow()
  expect(() => Option({ label: "ok", description: "   " })).toThrow()
})

test("Prompt.question rejects > 200 chars", () => {
  expect(() => Prompt({ ...validPrompt, question: "x".repeat(201) })).toThrow()
})

test("Prompt.question accepts exactly 200 chars", () => {
  expect(() => Prompt({ ...validPrompt, question: "x".repeat(200) })).not.toThrow()
})

test("Prompt.header rejects > 30 chars", () => {
  expect(() => Prompt({ ...validPrompt, header: "x".repeat(31) })).toThrow()
})

test("Prompt.header accepts exactly 30 chars", () => {
  expect(() => Prompt({ ...validPrompt, header: "x".repeat(30) })).not.toThrow()
})

test("Option.label rejects empty / whitespace-only", () => {
  expect(() => Option({ label: "", description: "ok" })).toThrow()
  expect(() => Option({ label: "   ", description: "ok" })).toThrow()
})

test("Prompt.question rejects empty / whitespace-only", () => {
  expect(() => Prompt({ ...validPrompt, question: "" })).toThrow()
  expect(() => Prompt({ ...validPrompt, question: "   " })).toThrow()
})

test("Prompt.options rejects fewer than 2", () => {
  expect(() => Prompt({ ...validPrompt, options: [validOption] })).toThrow()
})

test("Prompt.options rejects more than 4", () => {
  expect(() => Prompt({ ...validPrompt, options: Array(5).fill(validOption) })).toThrow()
})

test("Prompt.options accepts exactly 2", () => {
  expect(() => Prompt({ ...validPrompt, options: [validOption, validOption] })).not.toThrow()
})

test("Prompt.options accepts exactly 4", () => {
  expect(() => Prompt({ ...validPrompt, options: Array(4).fill(validOption) })).not.toThrow()
})

test("Prompt rejects custom: false with empty options (caught by options.min(2))", () => {
  expect(() => Prompt({ ...validPrompt, custom: false, options: [] })).toThrow()
})

test("Prompt accepts custom flag false and missing custom", () => {
  expect(() => Prompt({ ...validPrompt, custom: false })).not.toThrow()
  const { custom: _custom, ...withoutCustom } = validPrompt
  expect(() => Prompt(withoutCustom)).not.toThrow()
})

test("Prompt.question rejection message includes the actionable hint", () => {
  try {
    Prompt({ ...validPrompt, question: "x".repeat(201) })
    throw new Error("should have thrown")
  } catch (e: unknown) {
    const msg = String((e as { message?: unknown })?.message ?? e)
    expect(msg).toContain("Question is too long")
    expect(msg).toContain("max 200 chars")
  }
})

test("Prompt.options rejection message includes the actionable hint", () => {
  try {
    Prompt({ ...validPrompt, options: Array(5).fill(validOption) })
    throw new Error("should have thrown")
  } catch (e: unknown) {
    const msg = String((e as { message?: unknown })?.message ?? e)
    expect(msg).toContain("at most 4 options")
  }
})
