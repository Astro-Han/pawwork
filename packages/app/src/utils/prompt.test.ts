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

  test("restores source-less file:// parts as attachment chips", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "summarize this",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "text/plain",
        url: "file:///Users/me/Desktop/shot%202026.png",
        filename: "shot 2026.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "text/plain",
        url: "file:///Users/me/report.pdf?start=2&end=5",
        filename: "report.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result[0]).toMatchObject({ type: "text", content: "summarize this" })
    expect(result.slice(1)).toMatchObject([
      // mime re-derived from the suffix so the chip renders its thumbnail again.
      // The selection-scoped part (?start=&end=) is deliberately absent: see
      // "skips selection-scoped file parts" below.
      { type: "attachment", path: "/Users/me/Desktop/shot 2026.png", filename: "shot 2026.png", mime: "image/png" },
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

  test("skill part in history restores as an inline skill chip", () => {
    // Unlike agents (#239), skills are structured + persisted with a source span
    // and expand server-side, so fork/undo/revert must rebuild the chip — not
    // leave a literal "/name" that would no longer expand on resubmit.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "please /summarize this",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "skill_1",
        type: "skill",
        name: "summarize",
        source: { value: "/summarize", start: 7, end: 17 },
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result.map((p) => p.type)).toEqual(["text", "skill", "text"])
    expect(result[0]).toMatchObject({ type: "text", content: "please " })
    expect(result[1]).toMatchObject({ type: "skill", name: "summarize", content: "/summarize", start: 7, end: 17 })
    expect(result[2]).toMatchObject({ type: "text", content: " this" })
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

  test("command mode: restores user chip attachments and keeps template files suppressed", () => {
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
        url: "file:///tmp/template.md",
        filename: "template.md",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: { commandTemplate: true },
      },
      {
        id: "file_user",
        type: "file",
        mime: "text/plain",
        url: "file:///Users/me/report.pdf",
        filename: "report.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "text", content: "/brainstorming fold the bubble" })
    expect(result[1]).toMatchObject({ type: "attachment", path: "/Users/me/report.pdf", filename: "report.pdf" })
  })

  test("skips selection-scoped file parts instead of widening them to whole-file chips", () => {
    // Context items with a line selection submit as source-less file parts
    // whose only selection carrier is the ?start=&end= query. Restoring them
    // as path-only chips would silently expand a few-line reference into the
    // whole file on resubmit.
    const parts = [
      { id: "text_1", type: "text", text: "check this", sessionID: "ses_1", messageID: "msg_1" },
      {
        id: "file_ctx",
        type: "file",
        mime: "text/plain",
        url: "file:///Users/me/big-module.ts?start=120&end=132",
        filename: "big-module.ts",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: "text", content: "check this" })
  })

  test("command mode: skips inline-pill file parts already carried by the args text", () => {
    // `/summarize @guide.pdf` submits the inline pill as a file part WITH
    // source.text, while the mention text itself stays inside the args. The
    // engine re-derives a file part from that text on every command submit
    // (resolvePromptParts), so restoring the pill part as a chip would show the
    // same reference twice in the composer.
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "# Summarize\n\n...body...",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: {
          commandInvocation: { name: "summarize", args: "@guide.pdf", source: "command" },
          commandTemplate: true,
        },
      },
      {
        id: "file_pill",
        type: "file",
        mime: "text/plain",
        url: "file:///Users/me/guide.pdf",
        filename: "guide.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
        source: { type: "file", path: "/Users/me/guide.pdf", text: { value: "@guide.pdf", start: 11, end: 21 } },
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: "text", content: "/summarize @guide.pdf" })
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
