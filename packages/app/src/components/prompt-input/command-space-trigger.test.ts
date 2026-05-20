// Tests for Path B Space-trigger detection logic.
// Spec: §Path B (L224-235).

import { describe, expect, test } from "bun:test"
import type { CommandSource, ImageAttachmentPart } from "@/context/prompt"
import type { CommandDescriptor } from "./command-text-part"
import { tryPathBConversion } from "./command-space-trigger"

const reg: CommandDescriptor[] = [
  { name: "brainstorming", source: "skill" as CommandSource, icon: "command" },
]

const noImages: ImageAttachmentPart[] = []
const image: ImageAttachmentPart = {
  type: "image", id: "1", filename: "a.png", mime: "image/png", dataUrl: "data:img",
}

describe("tryPathBConversion", () => {
  test("`/brainstorming ` + insertText space → marked TextPart returned", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/brainstorming ",
      images: noImages, registry: reg,
    })
    expect(result).not.toBeNull()
    expect(result!.prompt.length).toBe(1)
    const part = result!.prompt[0]
    expect(part.type).toBe("text")
    expect((part as any).command?.name).toBe("brainstorming")
    expect((part as any).content).toBe("/brainstorming ")
    expect(result!.cursor).toBe("/brainstorming ".length)
  })

  test("`/Brainstorming ` + space → canonical case in metadata", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/Brainstorming ",
      images: noImages, registry: reg,
    })
    expect(result).not.toBeNull()
    expect((result!.prompt[0] as any).command.name).toBe("brainstorming")
  })

  test("`/notcmd ` + space → null (registry miss)", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/notcmd ",
      images: noImages, registry: reg,
    })
    expect(result).toBeNull()
  })

  test("non-insertText event (deleteContentBackward) → null", () => {
    const result = tryPathBConversion({
      inputType: "deleteContentBackward", data: null,
      rawText: "/brainstorming ",
      images: noImages, registry: reg,
    })
    expect(result).toBeNull()
  })

  test("insertText with data !== ' ' → null", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: "x",
      rawText: "/brainstorming",
      images: noImages, registry: reg,
    })
    expect(result).toBeNull()
  })

  test("insertCompositionText (IME commit) → null even if data is space", () => {
    const result = tryPathBConversion({
      inputType: "insertCompositionText", data: " ",
      rawText: "/brainstorming ",
      images: noImages, registry: reg,
    })
    expect(result).toBeNull()
  })

  test("buffer shape `/cmd args ` (space typed mid-args) → null", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/brainstorming hello ",
      images: noImages, registry: reg,
    })
    expect(result).toBeNull()
  })

  test("buffer shape `/cmd` (no trailing space, but data was ' ') → null", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/brainstorming",
      images: noImages, registry: reg,
    })
    expect(result).toBeNull()
  })

  test("image preservation: [Text('/cmd'), Image] state + Space → [marked, image]", () => {
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/brainstorming ",
      images: [image], registry: reg,
    })
    expect(result).not.toBeNull()
    expect(result!.prompt.length).toBe(2)
    expect(result!.prompt[1]).toBe(image)
  })

  test("multi-image identity stable", () => {
    const i2: ImageAttachmentPart = {
      type: "image", id: "2", filename: "b.png", mime: "image/png", dataUrl: "data:b",
    }
    const result = tryPathBConversion({
      inputType: "insertText", data: " ",
      rawText: "/brainstorming ",
      images: [image, i2], registry: reg,
    })
    expect(result!.prompt[1]).toBe(image)
    expect(result!.prompt[2]).toBe(i2)
  })
})
