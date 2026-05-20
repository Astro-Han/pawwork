import { describe, expect, test } from "bun:test"
import {
  assertCommandTextPart,
  createCommandTextPart,
  tryParseLeadingCommandFromText,
} from "./command-text-part"

const reg = [
  { name: "brainstorming", source: "skill" as const, icon: "command" },
  { name: "帮助", source: "skill" as const, icon: "command" },
]

describe("createCommandTextPart", () => {
  test("empty args produces content `/<name> ` with trailing space", () => {
    const part = createCommandTextPart({ name: "brainstorming", source: "skill", icon: "command" }, "")
    expect(part.type).toBe("text")
    expect(part.content).toBe("/brainstorming ")
    expect(part.start).toBe(0)
    expect(part.end).toBe(part.content.length)
    expect(part.command).toEqual({ name: "brainstorming", source: "skill", icon: "command" })
  })

  test("args preserved verbatim with single separator space", () => {
    const part = createCommandTextPart({ name: "brainstorming", source: "skill", icon: "command" }, "hello world")
    expect(part.content).toBe("/brainstorming hello world")
  })

  test("args with leading whitespace preserved verbatim — no further trim", () => {
    const part = createCommandTextPart({ name: "x", source: "skill", icon: "command" }, "  indented")
    expect(part.content).toBe("/x   indented")
  })
})

describe("tryParseLeadingCommandFromText", () => {
  test("registered name (case-insensitive ASCII) → canonical-cased TextPart", () => {
    const part = tryParseLeadingCommandFromText("/Brainstorming hello", reg)
    expect(part).not.toBeNull()
    expect(part!.command!.name).toBe("brainstorming")
    expect(part!.content).toBe("/brainstorming hello")
  })

  test("no args group → content is /<name> with trailing space", () => {
    const part = tryParseLeadingCommandFromText("/brainstorming", reg)
    expect(part).not.toBeNull()
    expect(part!.content).toBe("/brainstorming ")
  })

  test("single trailing space → content is /<name> with one space (args empty)", () => {
    const part = tryParseLeadingCommandFromText("/brainstorming ", reg)
    expect(part!.content).toBe("/brainstorming ")
  })

  test("double space between name and args: first is separator, second is verbatim args char", () => {
    const part = tryParseLeadingCommandFromText("/brainstorming  args", reg)
    expect(part!.content).toBe("/brainstorming  args")
  })

  test("unknown name → null", () => {
    expect(tryParseLeadingCommandFromText("/unknown hello", reg)).toBeNull()
  })

  test("newline separator → null", () => {
    expect(tryParseLeadingCommandFromText("/brainstorming\nargs", reg)).toBeNull()
  })

  test("tab separator → null", () => {
    expect(tryParseLeadingCommandFromText("/brainstorming\targs", reg)).toBeNull()
  })

  test("non-ASCII command name matches only byte-identically (no Unicode case-folding)", () => {
    const part = tryParseLeadingCommandFromText("/帮助 hi", reg)
    expect(part).not.toBeNull()
    expect(part!.command!.name).toBe("帮助")
  })

  test("length-preserve invariant: result.command.name.length === inputName.length for every match", () => {
    const inputs = ["/brainstorming", "/Brainstorming", "/BRAINSTORMING", "/帮助"]
    for (const s of inputs) {
      const part = tryParseLeadingCommandFromText(s, reg)
      const inputName = s.split(" ")[0].slice(1)
      expect(part).not.toBeNull()
      expect(part!.command!.name.length).toBe(inputName.length)
    }
  })

  test("empty name → null", () => {
    expect(tryParseLeadingCommandFromText("/ args", reg)).toBeNull()
  })
})

describe("assertCommandTextPart", () => {
  test("valid marked TextPart does not throw", () => {
    const part = createCommandTextPart({ name: "x", source: "skill", icon: "command" }, "args")
    expect(() => assertCommandTextPart(part)).not.toThrow()
  })

  test("content not starting with /<name> throws synchronously", () => {
    const bad = { type: "text" as const, content: "/wrong args", start: 0, end: 11,
      command: { name: "right", source: "skill" as const, icon: "command" } }
    expect(() => assertCommandTextPart(bad)).toThrow(/invariant/)
  })

  test("missing trailing space when args empty throws", () => {
    const bad = { type: "text" as const, content: "/x", start: 0, end: 2,
      command: { name: "x", source: "skill" as const, icon: "command" } }
    expect(() => assertCommandTextPart(bad)).toThrow(/invariant/)
  })
})
