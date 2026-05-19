import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { deriveCommandTitleSeed } from "../../src/session/prompt"

function textPart(id: string, text: string, metadata?: Record<string, unknown>): MessageV2.Part {
  return {
    id,
    type: "text",
    text,
    sessionID: "ses_1",
    messageID: "msg_1",
    ...(metadata ? { metadata } : {}),
  } as MessageV2.Part
}

function filePart(id: string): MessageV2.Part {
  return {
    id,
    type: "file",
    mime: "text/plain",
    url: "file:///workspace/notes.md",
    sessionID: "ses_1",
    messageID: "msg_1",
  } as MessageV2.Part
}

describe("deriveCommandTitleSeed", () => {
  test("uses commandInvocation from the first text part", () => {
    const parts = [
      textPart("t_1", "# Brainstorming methodology\n\nbody...", {
        commandInvocation: { name: "brainstorming", args: "fold the bubble", source: "command" },
        commandTemplate: true,
      }),
    ]
    expect(deriveCommandTitleSeed(parts)).toBe("Command: /brainstorming fold the bubble")
  })

  test("locates invocation on a later text part when @file precedes it", () => {
    // resolvePart can prepend synthetic read-text in front of a file reference,
    // pushing the original commandInvocation-bearing text past index 0. The
    // seed must still produce the same `Command: /<name> <args>` regardless of
    // where the carrier ends up.
    const parts = [
      textPart("t_syn", "Contents of notes.md\n```\n...\n```", { commandTemplate: true }),
      filePart("f_1"),
      textPart("t_body", "# Brainstorming methodology\n\nbody...", {
        commandInvocation: { name: "brainstorming", args: "fold the bubble", source: "command" },
        commandTemplate: true,
      }),
    ]
    expect(deriveCommandTitleSeed(parts)).toBe("Command: /brainstorming fold the bubble")
  })

  test("returns null when no part carries commandInvocation", () => {
    const parts = [textPart("t_1", "plain user message")]
    expect(deriveCommandTitleSeed(parts)).toBeNull()
  })

  test("returns null when commandInvocation has an invalid name", () => {
    const parts = [textPart("t_1", "x", { commandInvocation: { name: "", args: "y" } })]
    expect(deriveCommandTitleSeed(parts)).toBeNull()
  })

  test("omits args when invocation has none", () => {
    const parts = [
      textPart("t_1", "body", {
        commandInvocation: { name: "brainstorming", source: "command" },
        commandTemplate: true,
      }),
    ]
    expect(deriveCommandTitleSeed(parts)).toBe("Command: /brainstorming")
  })
})
