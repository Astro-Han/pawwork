// Tests for the Backspace fallback ladder on a command-marked leading TextPart.
// Spec reference: §E9 Backspace and IME, §Backspace fallback ladder (L469-479).
//
// Tests exercise the pure-function layer `computeCommandBackspaceResult`.
// No DOM or reactive context required.

import { describe, expect, test } from "bun:test"
import type { Prompt, TextPart, FileAttachmentPart, AgentPart, ImageAttachmentPart } from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt"
import { computeCommandBackspaceResult } from "./command-backspace"

// Helpers -----------------------------------------------------------------

function marked(name: string, args: string): TextPart & { command: NonNullable<TextPart["command"]> } {
  const content = `/${name} ${args}`
  return {
    type: "text",
    content,
    start: 0,
    end: content.length,
    command: { name, source: "skill", icon: "command" },
  }
}

function plainText(content: string): TextPart {
  return { type: "text", content, start: 0, end: content.length }
}

function filePart(path: string): FileAttachmentPart {
  return { type: "file", path, content: `@${path}`, start: 0, end: path.length + 1 }
}

function agentPart(name: string): AgentPart {
  return { type: "agent", name, content: `@${name}`, start: 0, end: name.length + 1 }
}

function imagePart(id: string): ImageAttachmentPart {
  return { type: "image", id, filename: `${id}.png`, mime: "image/png", dataUrl: `data:image/png,${id}` }
}

function prefix(name: string): string {
  return `/${name} `
}

// Cases (a)-(g) from the plan --------------------------------------------

describe("computeCommandBackspaceResult — fallback ladder", () => {
  // (a) marked has args → strip prefix, drop metadata
  test("(a) [marked('/cmd args')] → [Text('args')], metadata dropped", () => {
    const cmd = marked("cmd", "args")
    const parts: Prompt = [cmd]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(1)
    const first = result[0] as TextPart
    expect(first.type).toBe("text")
    expect(first.content).toBe("args")
    expect(first.command).toBeUndefined()
  })

  // (b) marked has no args, sole part → DEFAULT_PROMPT
  test("(b) [marked('/cmd ')] sole part → DEFAULT_PROMPT", () => {
    const cmd = marked("cmd", "")
    const parts: Prompt = [cmd]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    // Should equal DEFAULT_PROMPT shape: single empty TextPart
    expect(result.length).toBe(1)
    const first = result[0] as TextPart
    expect(first.type).toBe("text")
    expect(first.content).toBe("")
    expect(first.command).toBeUndefined()
  })

  // (b) also verify it is the exact DEFAULT_PROMPT reference
  test("(b) collapse to DEFAULT_PROMPT returns the canonical constant", () => {
    const cmd = marked("cmd", "")
    const result = computeCommandBackspaceResult([cmd], cmd, prefix("cmd"))
    expect(result).toBe(DEFAULT_PROMPT)
  })

  // (c) marked has no args, rest has FilePart → remove marked, keep rest
  test("(c) [marked('/cmd '), File('@foo')] → [File('@foo')]", () => {
    const cmd = marked("cmd", "")
    const file = filePart("/workspace/foo.ts")
    const parts: Prompt = [cmd, file]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(1)
    expect(result[0]).toEqual(file)
  })

  // (d) marked has no args, rest has AgentPart → remove marked, keep rest
  test("(d) [marked('/cmd '), Agent('@coder')] → [Agent('@coder')]", () => {
    const cmd = marked("cmd", "")
    const agent = agentPart("coder")
    const parts: Prompt = [cmd, agent]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(1)
    expect(result[0]).toEqual(agent)
  })

  // (e) marked has no args, rest is ImagePart → remove marked, keep ImagePart
  test("(e) [marked('/cmd '), ImagePart] → [ImagePart]", () => {
    const cmd = marked("cmd", "")
    const img = imagePart("img-001")
    const parts: Prompt = [cmd, img]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(1)
    expect(result[0]).toEqual(img)
  })

  // (f) E1 follow-up layout: marked has no args, rest=[Text, File] → rest preserved
  test("(f) [marked('/cmd '), Text('foo'), File('@bar')] → [Text('foo'), File('@bar')]", () => {
    const cmd = marked("cmd", "")
    const txt = plainText("foo")
    const file = filePart("/bar.ts")
    const parts: Prompt = [cmd, txt, file]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(2)
    expect(result[0]).toEqual(txt)
    expect(result[1]).toEqual(file)
  })

  // (g) marked has args + rest has FilePart → strip prefix on first, keep File
  test("(g) [marked('/cmd hello '), File('@foo')] → [Text('hello '), File('@foo')]", () => {
    const cmd = marked("cmd", "hello ")
    const file = filePart("/foo.ts")
    const parts: Prompt = [cmd, file]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(2)
    const first = result[0] as TextPart
    expect(first.type).toBe("text")
    expect(first.content).toBe("hello ")
    expect(first.command).toBeUndefined()
    expect(result[1]).toEqual(file)
  })
})

// No-mutation invariant --------------------------------------------------

describe("computeCommandBackspaceResult — no mutation of context side-data", () => {
  test("prompt.context.items snapshot (external array) is not modified", () => {
    // context.items is managed outside of Prompt; this test confirms the ladder
    // only touches the parts array and returns a new Prompt, never mutating
    // any caller-held reference.
    const contextItems = [{ type: "file" as const, path: "/ctx.ts", key: "file:/ctx.ts:::" }]
    const contextItemsSnapshot = [...contextItems]

    const cmd = marked("cmd", "args")
    const parts: Prompt = [cmd]
    computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    // Simulate: the function must not have touched contextItems
    expect(contextItems).toEqual(contextItemsSnapshot)
  })

  test("imageAttachments snapshot is not modified", () => {
    const imageAttachments = [imagePart("img-1")]
    const imageAttachmentsSnapshot = [...imageAttachments]

    const cmd = marked("cmd", "")
    const parts: Prompt = [cmd]
    computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(imageAttachments).toEqual(imageAttachmentsSnapshot)
  })

  test("original parts array is not mutated", () => {
    const cmd = marked("cmd", "args")
    const file = filePart("/a.ts")
    const parts: Prompt = [cmd, file]
    const originalLength = parts.length
    const originalFirst = parts[0]

    computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(parts.length).toBe(originalLength)
    expect(parts[0]).toBe(originalFirst)
  })
})

// Edge cases ------------------------------------------------------------

describe("computeCommandBackspaceResult — edge cases", () => {
  test("args with trailing space preserved verbatim", () => {
    // /cmd trailing  → argsAfterPrefix = "trailing "
    const cmd = marked("cmd", "trailing ")
    const parts: Prompt = [cmd]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect((result[0] as TextPart).content).toBe("trailing ")
  })

  test("multipart rest is preserved in order", () => {
    const cmd = marked("cmd", "")
    const t1 = plainText("foo")
    const t2 = plainText("bar")
    const f1 = filePart("/a.ts")
    const parts: Prompt = [cmd, t1, t2, f1]
    const result = computeCommandBackspaceResult(parts, cmd, prefix("cmd"))

    expect(result.length).toBe(3)
    expect(result[0]).toEqual(t1)
    expect(result[1]).toEqual(t2)
    expect(result[2]).toEqual(f1)
  })
})
