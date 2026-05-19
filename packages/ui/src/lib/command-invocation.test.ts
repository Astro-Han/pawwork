import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { deriveCommandInvocation, isCommandMessage } from "./command-invocation"

const textPart = (overrides: Record<string, unknown> = {}): Part =>
  ({
    type: "text",
    id: "t1",
    messageID: "m",
    sessionID: "s",
    text: "tmpl body",
    ...overrides,
  }) as Part

const filePart = (id: string, metadata?: Record<string, unknown>): Part =>
  ({
    type: "file",
    id,
    messageID: "m",
    sessionID: "s",
    mime: "image/png",
    url: "data:image/png;base64,xx",
    filename: id + ".png",
    metadata,
  }) as Part

describe("deriveCommandInvocation", () => {
  test("returns null when no part carries commandInvocation", () => {
    expect(deriveCommandInvocation([textPart()])).toBeNull()
    expect(isCommandMessage([textPart()])).toBe(false)
  })

  test("normalises a valid invocation", () => {
    const inv = deriveCommandInvocation([
      textPart({
        metadata: {
          commandInvocation: {
            name: "brainstorming",
            source: "skill",
            icon: "command",
            args: "fold cards",
            displayArgs: "fold cards",
          },
          commandTemplate: true,
        },
      }),
    ])
    expect(inv).not.toBeNull()
    expect(inv!.name).toBe("brainstorming")
    expect(inv!.source).toBe("skill")
    expect(inv!.markIcon).toBe("command")
    expect(inv!.args).toBe("fold cards")
    expect(inv!.displayLabel).toBe("brainstorming")
    expect(inv!.copyText).toBe("/brainstorming fold cards")
    expect(inv!.restoreText).toBe("/brainstorming fold cards")
    expect(inv!.forkPreviewText).toBe("/brainstorming fold cards")
    expect(inv!.suppressTextPartIds).toEqual(["t1"])
  })

  test("rejects missing/empty/non-string name", () => {
    expect(deriveCommandInvocation([textPart({ metadata: { commandInvocation: {} } })])).toBeNull()
    expect(deriveCommandInvocation([textPart({ metadata: { commandInvocation: { name: "" } } })])).toBeNull()
    expect(deriveCommandInvocation([textPart({ metadata: { commandInvocation: { name: 123 } } })])).toBeNull()
  })

  test("normalises bad source/icon to 'command'", () => {
    const inv = deriveCommandInvocation([
      textPart({ metadata: { commandInvocation: { name: "x", source: "bogus", icon: null } } }),
    ])
    expect(inv).not.toBeNull()
    expect(inv!.source).toBe("command")
    expect(inv!.markIcon).toBe("command")
  })

  test("normalises non-string args and rebuilds displayArgs", () => {
    const inv = deriveCommandInvocation([
      textPart({ metadata: { commandInvocation: { name: "x", args: null, displayArgs: 42 } } }),
    ])
    expect(inv).not.toBeNull()
    expect(inv!.args).toBe("")
    expect(inv!.copyText).toBe("/x")
    expect(inv!.restoreText).toBe("/x ")
    expect(inv!.forkPreviewText).toBe("/x")
  })

  test("collects suppressFilePartIds for template-marked file parts only", () => {
    const inv = deriveCommandInvocation([
      textPart({ metadata: { commandInvocation: { name: "x" }, commandTemplate: true } }),
      filePart("f-tmpl", { commandTemplate: true }),
      filePart("f-user"),
    ])
    expect(inv!.suppressFilePartIds).toEqual(["f-tmpl"])
  })

  test("truncates long args for displayArgs only", () => {
    const longArg = "a".repeat(150)
    const inv = deriveCommandInvocation([textPart({ metadata: { commandInvocation: { name: "x", args: longArg } } })])
    expect(inv!.args).toBe(longArg)
    // copyText = "/x " + longArg → 2 + 1 + 150 = 153
    expect(inv!.copyText.length).toBe(2 + 1 + longArg.length)
    expect(inv!.forkPreviewText.length).toBeLessThanOrEqual(2 + 1 + 80)
  })

  test("trims whitespace in args", () => {
    const inv = deriveCommandInvocation([
      textPart({ metadata: { commandInvocation: { name: "x", args: "  hello  " } } }),
    ])
    expect(inv!.args).toBe("hello")
  })
})
