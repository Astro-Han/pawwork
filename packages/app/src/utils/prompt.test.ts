import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractPromptFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })

  test("issue #239: AgentPart in history restores as plain text, not as an agent inline", () => {
    // Pre-#239 messages may contain a separate AgentPart record beside the text
    // that already includes "@<name>" inline. After #239 the picker is gone, so
    // the AgentPart must be ignored and the @<name> substring should restore as
    // plain text from the text part.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "ask @researcher to look at this",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "agent_1",
        type: "agent",
        name: "researcher",
        source: { value: "@researcher", start: 4, end: 15 },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    // No agent inline reconstructed
    expect(result.some((p) => p.type === "agent")).toBe(false)

    // The full original text (including the literal "@researcher") restores from
    // the text part as a single plain-text inline
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: "text", content: "ask @researcher to look at this" })
  })

  test("issue #239: AgentPart between file references does not disturb file offsets", () => {
    // File part offsets in the surrounding text must not shift even when an
    // AgentPart sits between them. The agent record is dropped entirely;
    // file inlines occupy their original positions.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "open @a.ts then @bot then @b.ts",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_a",
        type: "file",
        mime: "text/plain",
        url: "file:///workspace/a.ts",
        source: {
          type: "file",
          path: "/workspace/a.ts",
          text: { value: "@a.ts", start: 5, end: 10 },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "agent_1",
        type: "agent",
        name: "bot",
        source: { value: "@bot", start: 16, end: 20 },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_b",
        type: "file",
        mime: "text/plain",
        url: "file:///workspace/b.ts",
        source: {
          type: "file",
          path: "/workspace/b.ts",
          text: { value: "@b.ts", start: 26, end: 31 },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    // No agent in result
    expect(result.some((p) => p.type === "agent")).toBe(false)

    // File parts are present at their original offsets; @bot stays inside text
    const files = result.filter((p) => p.type === "file")
    expect(files).toHaveLength(2)
    // path strips the leading "@" from the source.text.value (extractor convention)
    expect(files[0]).toMatchObject({ type: "file", path: "a.ts", start: 5, end: 10 })
    expect(files[1]).toMatchObject({ type: "file", path: "b.ts", start: 26, end: 31 })

    // @bot stays as plain text in the surrounding text inlines
    const text = result
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join("")
    expect(text).toContain("@bot")
  })
})
