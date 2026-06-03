// Tests for Path C paste decision.
// Spec: §Path C (L237-263).

import { describe, expect, test } from "bun:test"
import type {
  CommandSource,
  ContextItem,
  FileAttachmentPart,
  ImageAttachmentPart,
  Prompt,
} from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt-equality"
import type { CommandDescriptor } from "./command-text-part"
import { tryPathCConversion } from "./command-paste"

const reg: CommandDescriptor[] = [
  { name: "brainstorming", source: "skill" as CommandSource, icon: "command" },
]

const empty = (): Prompt => DEFAULT_PROMPT
const file: FileAttachmentPart = {
  type: "file", path: "foo.ts", content: "@foo.ts", start: 0, end: 7,
}
const image: ImageAttachmentPart = {
  type: "image", id: "1", filename: "a.png", mime: "image/png", dataUrl: "data:img",
}

describe("tryPathCConversion", () => {
  test("`/brainstorming hello world` into structurally-empty input → marked", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming hello world",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).not.toBeNull()
    expect(result!.length).toBe(1)
    expect((result![0] as any).command.name).toBe("brainstorming")
    expect((result![0] as any).content).toBe("/brainstorming hello world")
  })

  test("same string with existing text → null (fall back to plain paste)", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming hello",
      currentPrompt: [{ type: "text", content: "hi", start: 0, end: 2 }],
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("with only file attachment present → null (attachment preserved)", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming hello",
      currentPrompt: [file],
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("with only image attachment present → null", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming hello",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [image],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("with context items present → null", () => {
    const ctx: ContextItem[] = [{ type: "file", path: "foo.ts" }]
    const result = tryPathCConversion({
      plainText: "/brainstorming hello",
      currentPrompt: empty(),
      contextItems: ctx,
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("newline separator → null (regex requires single ASCII space)", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming\nargs",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("Codex-style markdown link → null (not a command shape)", () => {
    const result = tryPathCConversion({
      plainText: "[foo.ts](path/foo.ts)",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("composing=true → null even when structurally empty + valid command", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming hello",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: true,
    })
    expect(result).toBeNull()
  })

  test("registry miss → null", () => {
    const result = tryPathCConversion({
      plainText: "/unknown args",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).toBeNull()
  })

  test("`/brainstorming` (no args, no separator) into empty → marked with trailing space", () => {
    const result = tryPathCConversion({
      plainText: "/brainstorming",
      currentPrompt: empty(),
      contextItems: [],
      imageAttachments: [],
      registry: reg,
      composing: false,
    })
    expect(result).not.toBeNull()
    expect((result![0] as any).content).toBe("/brainstorming ")
  })
})
