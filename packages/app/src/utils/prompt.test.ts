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

  test("command mode: restores `/<cmd> <args>` and preserves user attachments", () => {
    // A command invocation produces a TextPart carrying commandInvocation
    // metadata (its body is the expanded template) plus any template-side files
    // tagged commandTemplate=true. The user can also attach a markerless image
    // alongside. Restore must drop the expanded body, drop the template file,
    // and keep the user's image so undo replays the same input.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "# Brainstorming methodology\n\n...body...",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: {
          commandInvocation: { name: "brainstorming", args: "fold the bubble", source: "command" },
          commandTemplate: true,
        },
      },
      {
        id: "file_template",
        type: "file",
        mime: "text/plain",
        url: "data:text/plain;base64,VEVNUExBVEU=",
        filename: "template.md",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: { commandTemplate: true },
      },
      {
        id: "file_user",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,VVNFUg==",
        filename: "screenshot.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(2)
    // Must be a marked TextPart (command field present) for pill re-render.
    expect(result[0]).toMatchObject({
      type: "text",
      content: "/brainstorming fold the bubble",
      command: { name: "brainstorming", source: "command" },
    })
    expect(result[1]).toMatchObject({
      type: "image",
      filename: "screenshot.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,VVNFUg==",
    })
  })

  test("command mode without args: restores `/<cmd> ` with trailing space and no body", () => {
    // restoreText keeps a trailing space when args are empty so the editor
    // caret lands ready for typing without re-triggering completion.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "# Brainstorming methodology\n\n...body...",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: {
          commandInvocation: { name: "brainstorming", source: "command" },
          commandTemplate: true,
        },
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(1)
    // Marked TextPart: trailing space present, command metadata attached.
    expect(result[0]).toMatchObject({
      type: "text",
      content: "/brainstorming ",
      command: { name: "brainstorming", source: "command" },
    })
  })

  test("command mode: suppresses commandTemplate-tagged file even when alone", () => {
    // Without a markerless companion the restore output is text-only — the
    // template file must not leak through as an attachment.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "# template body",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: {
          commandInvocation: { name: "explain", args: "this", source: "command" },
          commandTemplate: true,
        },
      },
      {
        id: "file_template",
        type: "file",
        mime: "text/plain",
        url: "data:text/plain;base64,VEVNUExBVEU=",
        filename: "template.md",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: { commandTemplate: true },
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(1)
    // Marked TextPart: template file suppressed, command metadata attached.
    expect(result[0]).toMatchObject({
      type: "text",
      content: "/explain this",
      command: { name: "explain", source: "command" },
    })
  })
})
