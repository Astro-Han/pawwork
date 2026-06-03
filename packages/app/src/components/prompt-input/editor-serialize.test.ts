import { describe, expect, test } from "bun:test"
import {
  createCommandMark,
  createPill,
  isNormalizedEditor,
  parseEditorToParts,
  renderPartsToEditor,
} from "./editor-serialize"
import type { Prompt, SkillAttachmentPart, TextPart } from "@/context/prompt"

// Helper: build a leading-command TextPart
function makeCommandPart(name: string, tail: string): TextPart {
  return {
    type: "text",
    content: "/" + name + tail,
    start: 0,
    end: 1 + name.length + tail.length,
    command: { name, source: "skill", icon: "command" },
  }
}

describe("createCommandMark", () => {
  test("outer span carries data-cmd-mark, data-name, data-source, data-icon, contenteditable=false", () => {
    const part = makeCommandPart("summarize", " ")
    const el = createCommandMark(part as TextPart & { command: NonNullable<TextPart["command"]> })

    expect(el.dataset.cmdMark).toBe("true")
    expect(el.dataset.name).toBe("summarize")
    expect(el.dataset.source).toBe("skill")
    expect(el.dataset.icon).toBe("command")
    expect(el.getAttribute("contenteditable")).toBe("false")
  })

  test("visible textContent is the command name without a slash", () => {
    const part = makeCommandPart("brainstorming", " ")
    const el = createCommandMark(part as TextPart & { command: NonNullable<TextPart["command"]> })

    // The label child carries the name; the icon child may add non-visible text
    const label = el.querySelector("[data-cmd-label]") as HTMLElement
    expect(label.textContent).toBe("brainstorming")
    // Full textContent should NOT start with "/"
    expect(el.textContent).not.toMatch(/^\//)
  })

  test("icon child has data-cmd-icon and class=command-icon", () => {
    const part = makeCommandPart("go", " ")
    const el = createCommandMark(part as TextPart & { command: NonNullable<TextPart["command"]> })

    const icon = el.querySelector("[data-cmd-icon]") as HTMLElement
    expect(icon).not.toBeNull()
    expect(icon.getAttribute("aria-hidden")).toBe("true")
    expect(icon.className).toBe("command-icon")
  })
})

describe("renderPartsToEditor + parseEditorToParts round-trips", () => {
  function roundTrip(parts: TextPart[]) {
    const editor = document.createElement("div")
    renderPartsToEditor(editor, parts)
    return parseEditorToParts(editor)
  }

  test('"/cmd " round-trips byte-identical', () => {
    const original = [makeCommandPart("cmd", " ")]
    const result = roundTrip(original)

    expect(result.length).toBe(1)
    expect(result[0]!.type).toBe("text")
    const textPart = result[0] as TextPart
    expect(textPart.content).toBe("/cmd ")
    expect(textPart.command).toEqual({ name: "cmd", source: "skill", icon: "command" })
  })

  test('"/cmd args" round-trips byte-identical', () => {
    const original = [makeCommandPart("cmd", " args")]
    const result = roundTrip(original)

    const textPart = result[0] as TextPart
    expect(textPart.content).toBe("/cmd args")
    expect(textPart.command?.name).toBe("cmd")
  })

  test('"/cmd  args" (double-space) round-trips byte-identical', () => {
    // First space is the separator, second is verbatim part of args
    const original = [makeCommandPart("cmd", "  args")]
    const result = roundTrip(original)

    const textPart = result[0] as TextPart
    expect(textPart.content).toBe("/cmd  args")
    expect(textPart.command?.name).toBe("cmd")
  })

  test("pill DOM has no leading slash in visible label text", () => {
    const original = [makeCommandPart("summarize", " ")]
    const editor = document.createElement("div")
    renderPartsToEditor(editor, original)

    const pill = editor.querySelector("[data-cmd-mark]") as HTMLElement
    expect(pill).not.toBeNull()
    const label = pill.querySelector("[data-cmd-label]") as HTMLElement
    expect(label.textContent).not.toMatch(/^\//)
    expect(label.textContent).toBe("summarize")
  })

  test("parsed part carries command metadata with name, source, icon", () => {
    const original = [makeCommandPart("brainstorming", " hello")]
    const result = roundTrip(original)

    const textPart = result[0] as TextPart
    expect(textPart.command).toEqual({ name: "brainstorming", source: "skill", icon: "command" })
  })
})

describe("inline skill pill", () => {
  function makeSkill(name: string, source: SkillAttachmentPart["source"] = "skill"): SkillAttachmentPart {
    return { type: "skill", name, source, content: "/" + name, start: 0, end: 1 + name.length }
  }

  test("createPill skill carries data-type, data-name, data-source, contenteditable=false", () => {
    const pill = createPill(makeSkill("summarize"))
    expect(pill.dataset.type).toBe("skill")
    expect(pill.dataset.name).toBe("summarize")
    expect(pill.dataset.source).toBe("skill")
    expect(pill.getAttribute("contenteditable")).toBe("false")
  })

  test("createPill skill keeps textContent === '/name' so caret math is unaffected", () => {
    const pill = createPill(makeSkill("summarize"))
    // The icon child adds no visible text; the label child carries "/summarize".
    expect(pill.textContent).toBe("/summarize")
    const icon = pill.querySelector("[data-cmd-icon]") as HTMLElement
    expect(icon).not.toBeNull()
    expect(icon.className).toBe("command-icon")
    const label = pill.querySelector("[data-cmd-label]") as HTMLElement
    expect(label.textContent).toBe("/summarize")
  })

  test("round-trips prose + skill + prose, recovering name/source/content", () => {
    const parts: Prompt = [
      { type: "text", content: "hello ", start: 0, end: 6 },
      makeSkill("summarize"),
      { type: "text", content: " world", start: 0, end: 6 },
    ]
    const editor = document.createElement("div")
    renderPartsToEditor(editor, parts)
    const result = parseEditorToParts(editor)

    expect(result.map((p) => p.type)).toEqual(["text", "skill", "text"])
    const skill = result[1] as SkillAttachmentPart
    expect(skill.name).toBe("summarize")
    expect(skill.source).toBe("skill")
    expect(skill.content).toBe("/summarize")
    // Position is recomputed against the flattened text "hello /summarize world".
    expect(skill.start).toBe(6)
    expect(skill.end).toBe(16)
    expect((result[0] as TextPart).content).toBe("hello ")
    expect((result[2] as TextPart).content).toBe(" world")
  })

  test("defaults missing data-source to skill on parse", () => {
    const editor = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "skill"
    pill.dataset.name = "summarize"
    pill.textContent = "/summarize"
    editor.appendChild(pill)
    const result = parseEditorToParts(editor)
    expect((result[0] as SkillAttachmentPart).source).toBe("skill")
  })
})

describe("isNormalizedEditor skill-pill position independence", () => {
  test("a skill pill mid-stream stays normalized (no rebuild)", () => {
    const editor = document.createElement("div")
    editor.appendChild(document.createTextNode("prefix "))
    editor.appendChild(createPill({ type: "skill", name: "go", source: "skill", content: "/go", start: 0, end: 3 }))
    editor.appendChild(document.createTextNode(" suffix"))
    expect(isNormalizedEditor(editor)).toBe(true)
  })
})

describe("isNormalizedEditor command-pill position invariant", () => {
  function buildPill(name: string): HTMLSpanElement {
    const pill = document.createElement("span")
    pill.dataset.cmdMark = "true"
    pill.dataset.name = name
    pill.dataset.source = "skill"
    pill.dataset.icon = "command"
    pill.setAttribute("contenteditable", "false")
    const label = document.createElement("span")
    label.dataset.cmdLabel = "true"
    label.textContent = name
    pill.appendChild(label)
    return pill
  }

  test("cmd-mark at index 0 is treated as normalized", () => {
    const editor = document.createElement("div")
    editor.appendChild(buildPill("go"))
    editor.appendChild(document.createTextNode(" args"))
    expect(isNormalizedEditor(editor)).toBe(true)
  })

  test("cmd-mark at non-zero index forces reconcile", () => {
    // Invariant breach: marked TextPart must always be index 0. A mid-stream
    // pill should make isNormalizedEditor return false so the reconcile pass
    // rebuilds the editor from the canonical Prompt and self-heals.
    const editor = document.createElement("div")
    editor.appendChild(document.createTextNode("prefix "))
    editor.appendChild(buildPill("go"))
    expect(isNormalizedEditor(editor)).toBe(false)
  })
})

describe("self-heal: mid-stream data-cmd-mark → plain text, no command field", () => {
  test("cmd-mark not at index 0 is parsed as plain text without command metadata", () => {
    // Manually build an editor where the cmd-mark pill appears AFTER some text
    const editor = document.createElement("div")
    editor.appendChild(document.createTextNode("prefix "))

    const pill = document.createElement("span")
    pill.dataset.cmdMark = "true"
    pill.dataset.name = "summarize"
    pill.dataset.source = "skill"
    pill.dataset.icon = "command"
    pill.setAttribute("contenteditable", "false")

    // Inner structure matching createCommandMark output
    const label = document.createElement("span")
    label.dataset.cmdLabel = "true"
    label.textContent = "summarize"
    pill.appendChild(label)

    editor.appendChild(pill)
    editor.appendChild(document.createTextNode(" suffix"))

    const result = parseEditorToParts(editor)

    // Should produce a single plain text part (no leading pill branch triggered)
    expect(result.length).toBe(1)
    const textPart = result[0] as TextPart
    expect(textPart.type).toBe("text")
    // No command metadata on a mid-stream pill
    expect(textPart.command).toBeUndefined()
    // The label text should appear in content (visit recurses into span children)
    expect(textPart.content).toContain("summarize")
  })
})
