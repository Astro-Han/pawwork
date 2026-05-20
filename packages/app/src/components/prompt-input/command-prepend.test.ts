// Tests for prependCommandMark — the pure helper that computes the new Prompt
// when a custom slash command is selected from the popover.
// Spec reference: §Path A (L200-222), §E1 variant (L209-222).
//
// No DOM or reactive context required.

import { describe, expect, test } from "bun:test"
import type { Prompt, TextPart, FileAttachmentPart, AgentPart, ImageAttachmentPart } from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt"
import type { CommandDescriptor } from "./command-text-part"
import { prependCommandMark } from "./command-prepend"

// Helpers -----------------------------------------------------------------

function cmd(name: string, source: CommandDescriptor["source"] = "command"): CommandDescriptor {
  return { name, source, icon: "command" }
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

function plainText(content: string): TextPart {
  return { type: "text", content, start: 0, end: content.length }
}

// Inspect the leading marked TextPart returned by prependCommandMark.
function getMarked(result: Prompt): TextPart {
  const first = result[0]
  if (first.type !== "text") throw new Error("expected TextPart at index 0")
  return first
}

// Empty prompt cases -------------------------------------------------------

describe("prependCommandMark — empty prompt", () => {
  test("empty prompt → [marked, ...images], ImagePart identity preserved", () => {
    const img = imagePart("img-001")
    const result = prependCommandMark(DEFAULT_PROMPT, [img], cmd("brainstorming"))

    expect(result.length).toBe(2)

    const marked = getMarked(result)
    expect(marked.command?.name).toBe("brainstorming")
    expect(marked.content).toBe("/brainstorming ")

    // Reference identity — no cloning of incoming image parts.
    expect(result[1]).toBe(img)
  })

  test("empty prompt + no images → [marked] only", () => {
    const result = prependCommandMark(DEFAULT_PROMPT, [], cmd("review"))

    expect(result.length).toBe(1)
    const marked = getMarked(result)
    expect(marked.command?.name).toBe("review")
  })

  test("cursor target = marked content length", () => {
    const result = prependCommandMark(DEFAULT_PROMPT, [], cmd("x"))
    const marked = getMarked(result)
    // Content is "/x " (3 chars).
    expect(marked.content.length).toBe(3)
  })

  test("marked TextPart has trailing space (createCommandTextPart contract)", () => {
    const result = prependCommandMark(DEFAULT_PROMPT, [], cmd("do-it"))
    const marked = getMarked(result)
    expect(marked.content).toBe("/do-it ")
    expect(marked.content.endsWith(" ")).toBe(true)
  })

  test("source and icon forwarded into command metadata", () => {
    const descriptor: CommandDescriptor = { name: "scan", source: "skill", icon: "sparkles" }
    const result = prependCommandMark(DEFAULT_PROMPT, [], descriptor)
    const marked = getMarked(result)
    expect(marked.command?.source).toBe("skill")
    expect(marked.command?.icon).toBe("sparkles")
  })

  test("multiple image attachments → all images follow marked in order", () => {
    const img1 = imagePart("img-001")
    const img2 = imagePart("img-002")
    const result = prependCommandMark(DEFAULT_PROMPT, [img1, img2], cmd("brainstorming"))

    expect(result.length).toBe(3)
    expect(result[1]).toBe(img1)
    expect(result[2]).toBe(img2)
  })
})

// Non-empty prompt cases (E1 variant) -------------------------------------

describe("prependCommandMark — non-empty prompt (E1 variant)", () => {
  test("non-empty prompt → [marked, ...current], original parts in original order", () => {
    const file = filePart("/workspace/foo.ts")
    const txt = plainText("some context")
    const current: Prompt = [txt, file]
    const result = prependCommandMark(current, [], cmd("review"))

    expect(result.length).toBe(3)
    const marked = getMarked(result)
    expect(marked.command?.name).toBe("review")
    // Original parts in original order and by reference.
    expect(result[1]).toBe(txt)
    expect(result[2]).toBe(file)
  })

  test("FilePart identity preserved (no clone)", () => {
    const file = filePart("/src/main.ts")
    const current: Prompt = [plainText(""), file]
    const result = prependCommandMark(current, [], cmd("review"))
    const fileInResult = result.find((p) => p.type === "file")
    expect(fileInResult).toBe(file)
  })

  test("AgentPart identity preserved (no clone)", () => {
    const agent = agentPart("coder")
    const current: Prompt = [plainText(""), agent]
    const result = prependCommandMark(current, [], cmd("refactor"))
    const agentInResult = result.find((p) => p.type === "agent")
    expect(agentInResult).toBe(agent)
  })

  test("cursor target = marked content.length", () => {
    const current: Prompt = [plainText("existing text")]
    const result = prependCommandMark(current, [], cmd("analyze"))
    const marked = getMarked(result)
    // "/analyze " = 9 chars
    expect(marked.content.length).toBe("/analyze ".length)
  })

  test("images passed as second arg are ignored when prompt is non-empty (current already has them)", () => {
    // E1: when current is non-empty, images arg is not used — caller passes
    // imageAttachments() separately only for the empty-prompt case.
    const img = imagePart("img-003")
    const current: Prompt = [plainText("text"), img]
    const result = prependCommandMark(current, [], cmd("summarize"))

    // Result should be [marked, plainText, img] — the image comes from current,
    // not from the images arg (which is empty here).
    expect(result.length).toBe(3)
    expect(result[2]).toBe(img)
  })

  test("interleaved File + Text parts all preserved by reference", () => {
    const t1 = plainText("first chunk")
    const f1 = filePart("/a.ts")
    const t2 = plainText("second chunk")
    const f2 = filePart("/b.ts")
    const current: Prompt = [t1, f1, t2, f2]
    const result = prependCommandMark(current, [], cmd("review"))

    expect(result.length).toBe(5)
    expect(result[1]).toBe(t1)
    expect(result[2]).toBe(f1)
    expect(result[3]).toBe(t2)
    expect(result[4]).toBe(f2)
  })
})

// No-mutation invariant ---------------------------------------------------

describe("prependCommandMark — no mutation", () => {
  test("original current array is not mutated", () => {
    const file = filePart("/x.ts")
    const current: Prompt = [plainText("hello"), file]
    const snapshot = [...current]
    prependCommandMark(current, [], cmd("review"))
    expect(current.length).toBe(snapshot.length)
    expect(current[0]).toBe(snapshot[0])
    expect(current[1]).toBe(snapshot[1])
  })

  test("original images array is not mutated", () => {
    const img = imagePart("img-001")
    const images = [img]
    prependCommandMark(DEFAULT_PROMPT, images, cmd("review"))
    expect(images.length).toBe(1)
    expect(images[0]).toBe(img)
  })
})
