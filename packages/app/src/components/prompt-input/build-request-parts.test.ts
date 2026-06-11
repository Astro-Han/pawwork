import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { buildAttachmentRequestParts, buildRequestParts } from "./build-request-parts"
import { captureCommentMentions } from "./mention-metadata"

describe("buildRequestParts", () => {
  test("builds typed request and optimistic parts without cast path", () => {
    const prompt: Prompt = [
      { type: "text", content: "hello", start: 0, end: 5 },
      {
        type: "file",
        path: "src/foo.ts",
        content: "@src/foo.ts",
        start: 5,
        end: 16,
        selection: { startLine: 4, startChar: 1, endLine: 6, endChar: 1 },
      },
      { type: "agent", name: "planner", content: "@planner", start: 16, end: 24 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [{ key: "ctx:1", type: "file", path: "src/bar.ts", comment: "check this" }],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      ],
      text: "hello @src/foo.ts @planner",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    expect(result.requestParts[0]?.type).toBe("text")
    expect(result.requestParts.some((part) => part.type === "agent")).toBe(true)
    expect(
      result.requestParts.some((part) => part.type === "file" && part.url.startsWith("file:///repo/src/foo.ts")),
    ).toBe(true)
    expect(result.requestParts.some((part) => part.type === "text" && part.synthetic)).toBe(true)
    expect(
      result.requestParts.some(
        (part) =>
          part.type === "text" &&
          part.synthetic &&
          part.metadata?.opencodeComment &&
          (part.metadata.opencodeComment as { comment?: string }).comment === "check this",
      ),
    ).toBe(true)

    expect(result.optimisticParts).toHaveLength(result.requestParts.length)
    expect(result.optimisticParts.every((part) => part.sessionID === "ses_1" && part.messageID === "msg_1")).toBe(true)
  })

  test("emits a SkillPartInput and a matching optimistic skill part", () => {
    const prompt: Prompt = [
      { type: "text", content: "please ", start: 0, end: 7 },
      { type: "skill", name: "summarize", source: "skill", content: "/summarize", start: 7, end: 17 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "please /summarize",
      messageID: "msg_skill",
      sessionID: "ses_skill",
      sessionDirectory: "/repo",
    })

    const skill = result.requestParts.find((part) => part.type === "skill")
    expect(skill).toBeDefined()
    if (skill?.type === "skill") {
      expect(skill.name).toBe("summarize")
      // The "/summarize" span is tagged so the bubble can render it as a chip.
      expect(skill.source).toEqual({ value: "/summarize", start: 7, end: 17 })
    }

    // The optimistic part must mirror the persisted SkillPart so the bubble
    // does not flicker — and NOT degrade into an agent part via the fallthrough.
    const optimisticSkill = result.optimisticParts.find((part) => part.type === "skill")
    expect(optimisticSkill).toBeDefined()
    if (optimisticSkill?.type === "skill") {
      expect(optimisticSkill.name).toBe("summarize")
      expect(optimisticSkill.sessionID).toBe("ses_skill")
      expect(optimisticSkill.messageID).toBe("msg_skill")
      expect(optimisticSkill.source).toEqual({ value: "/summarize", start: 7, end: 17 })
    }
    expect(result.optimisticParts.some((part) => part.type === "agent")).toBe(false)
  })

  test("keeps multiple uploaded attachments in order", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "check these", start: 0, end: 11 }],
      context: [],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
        {
          type: "image",
          id: "img_2",
          filename: "b.pdf",
          mime: "application/pdf",
          dataUrl: "data:application/pdf;base64,BBB",
        },
      ],
      text: "check these",
      messageID: "msg_multi",
      sessionID: "ses_multi",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file" && part.url.startsWith("data:"))

    expect(files).toHaveLength(2)
    expect(files.map((part) => (part.type === "file" ? part.filename : ""))).toEqual(["a.png", "b.pdf"])
  })

  test("deduplicates context files when prompt already includes same path", () => {
    const prompt: Prompt = [{ type: "file", path: "src/foo.ts", content: "@src/foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:dup", type: "file", path: "src/foo.ts" },
        { key: "ctx:comment", type: "file", path: "src/foo.ts", comment: "focus here" },
      ],
      images: [],
      text: "@src/foo.ts",
      messageID: "msg_2",
      sessionID: "ses_2",
      sessionDirectory: "/repo",
    })

    const fooFiles = result.requestParts.filter(
      (part) => part.type === "file" && part.url.startsWith("file:///repo/src/foo.ts"),
    )
    const synthetic = result.requestParts.filter((part) => part.type === "text" && part.synthetic)

    expect(fooFiles).toHaveLength(2)
    expect(synthetic).toHaveLength(1)
  })

  test("adds file parts for @mentions inside comment text", () => {
    const comment = "Compare with @src/shared.ts and @src/review.ts."
    const resolvedMentions = captureCommentMentions({ comment, sourceFilesystemDirectory: "/repo" })

    const result = buildRequestParts({
      prompt: [{ type: "text", content: "look", start: 0, end: 4 }],
      context: [
        {
          key: "ctx:comment-mention",
          type: "file",
          path: "src/review.ts",
          comment,
          resolvedMentions,
        },
      ],
      images: [],
      text: "look",
      messageID: "msg_comment_mentions",
      sessionID: "ses_comment_mentions",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    expect(files).toHaveLength(2)
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo/src/review.ts")).toBe(true)
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo/src/shared.ts")).toBe(true)
  })

  test("attaches mention with resolved metadata pointing outside sessionDirectory", () => {
    const comment = "compare with @src/shared.ts"
    // Metadata was captured against repo-A, but submit happens in repo-B context
    const resolvedMentions = captureCommentMentions({ comment, sourceFilesystemDirectory: "/repo-A" })

    const result = buildRequestParts({
      prompt: [{ type: "text", content: "compare", start: 0, end: 7 }],
      context: [
        {
          key: "ctx:cross-workspace",
          type: "file",
          path: "/repo-A/src/a.ts",
          comment,
          resolvedMentions,
        },
      ],
      images: [],
      text: "compare",
      messageID: "msg_cross",
      sessionID: "ses_cross",
      sessionDirectory: "/repo-B",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    // The mention should resolve to /repo-A/src/shared.ts, NOT /repo-B/src/shared.ts
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo-A/src/shared.ts")).toBe(true)
    expect(files.every((part) => !(part.type === "file" && part.url.startsWith("file:///repo-B/src/shared")))).toBe(true)
  })

  test("free-text @ in comment without resolvedMentions is not attached", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "look", start: 0, end: 4 }],
      context: [
        {
          key: "ctx:no-metadata",
          type: "file",
          path: "src/main.ts",
          comment: "see @src/lost.ts for details",
          // resolvedMentions deliberately omitted (undefined)
        },
      ],
      images: [],
      text: "look",
      messageID: "msg_no_meta",
      sessionID: "ses_no_meta",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    // Only src/main.ts should appear — @src/lost.ts has no metadata so it is dropped
    expect(files.every((part) => !(part.type === "file" && part.url.includes("lost.ts")))).toBe(true)
  })

  test("handles Windows paths correctly (simulated on macOS)", () => {
    const prompt: Prompt = [{ type: "file", path: "src\\foo.ts", content: "@src\\foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\foo.ts",
      messageID: "msg_win_1",
      sessionID: "ses_win_1",
      sessionDirectory: "D:\\projects\\myapp", // Windows path
    })

    // Should create valid file URLs
    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should not have encoded backslashes in wrong place
      expect(filePart.url).not.toContain("%5C")
      // Should have normalized to forward slashes
      expect(filePart.url).toContain("/src/foo.ts")
    }
  })

  test("handles Windows absolute path with special characters", () => {
    const prompt: Prompt = [{ type: "file", path: "file#name.txt", content: "@file#name.txt", start: 0, end: 14 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@file#name.txt",
      messageID: "msg_win_2",
      sessionID: "ses_win_2",
      sessionDirectory: "C:\\Users\\test\\Documents", // Windows path
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Special chars should be encoded
      expect(filePart.url).toContain("file%23name.txt")
      // Should have Windows drive letter properly encoded
      expect(filePart.url).toMatch(/file:\/\/\/[A-Z]:/)
    }
  })

  test("handles Linux absolute paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 10 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src/app.ts",
      messageID: "msg_linux_1",
      sessionID: "ses_linux_1",
      sessionDirectory: "/home/user/project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should be a normal Unix path
      expect(filePart.url).toBe("file:///home/user/project/src/app.ts")
    }
  })

  test("handles macOS paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "README.md", content: "@README.md", start: 0, end: 9 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@README.md",
      messageID: "msg_mac_1",
      sessionID: "ses_mac_1",
      sessionDirectory: "/Users/kelvin/Projects/opencode",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should be a normal Unix path
      expect(filePart.url).toBe("file:///Users/kelvin/Projects/opencode/README.md")
    }
  })

  test("preserves absolute external macOS file paths", () => {
    const path = "/Users/kelvin/Documents/客户 reports/final (signed)'s copy.docx"
    const result = buildRequestParts({
      prompt: [{ type: "file", path, content: "@" + path, start: 0, end: path.length + 1 }],
      context: [],
      images: [],
      text: "@" + path,
      messageID: "msg_external_abs",
      sessionID: "ses_external_abs",
      sessionDirectory: "/Users/kelvin/Projects/pawwork",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      expect(() => new URL(filePart.url)).not.toThrow()
      expect(filePart.source?.type).toBe("file")
      if (filePart.source?.type === "file") expect(filePart.source.path).toBe(path)
      expect(filePart.url).toContain("/Users/kelvin/Documents/")
      expect(filePart.url).toContain("%E5%AE%A2%E6%88%B7%20reports")
      expect(filePart.url).toContain("final%20(signed)'s%20copy.docx")
    }
  })

  test("preserves UNC style paths as parseable file URLs", () => {
    const path = "\\\\server\\share\\客户 file.docx"
    const result = buildRequestParts({
      prompt: [{ type: "file", path, content: "@" + path, start: 0, end: path.length + 1 }],
      context: [],
      images: [],
      text: "@" + path,
      messageID: "msg_unc",
      sessionID: "ses_unc",
      sessionDirectory: "C:\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      const url = new URL(filePart.url)
      expect(filePart.source?.type).toBe("file")
      if (filePart.source?.type === "file") expect(filePart.source.path).toBe(path)
      expect(filePart.url).not.toContain("%5C")
      expect(url.protocol).toBe("file:")
      expect(url.hostname).toBe("server")
      expect(decodeURIComponent(url.pathname)).toBe("/share/客户 file.docx")
    }
  })

  test("handles context files with Windows paths", () => {
    const prompt: Prompt = []

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:1", type: "file", path: "src\\utils\\helper.ts" },
        { key: "ctx:2", type: "file", path: "test\\unit.test.ts", comment: "check tests" },
      ],
      images: [],
      text: "test",
      messageID: "msg_win_ctx",
      sessionID: "ses_win_ctx",
      sessionDirectory: "D:\\workspace\\app",
    })

    const fileParts = result.requestParts.filter((part) => part.type === "file")
    expect(fileParts).toHaveLength(2)

    // All file URLs should be valid
    fileParts.forEach((part) => {
      if (part.type === "file") {
        expect(() => new URL(part.url)).not.toThrow()
        expect(part.url).not.toContain("%5C") // No encoded backslashes
      }
    })
  })

  test("handles absolute Windows paths (user manually specifies full path)", () => {
    const prompt: Prompt = [
      { type: "file", path: "D:\\other\\project\\file.ts", content: "@D:\\other\\project\\file.ts", start: 0, end: 25 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@D:\\other\\project\\file.ts",
      messageID: "msg_abs",
      sessionID: "ses_abs",
      sessionDirectory: "C:\\current\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should handle absolute path that differs from sessionDirectory
      expect(() => new URL(filePart.url)).not.toThrow()
      expect(filePart.url).toContain("/D:/other/project/file.ts")
    }
  })

  test("handles selection with query parameters on Windows", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "src\\App.tsx",
        content: "@src\\App.tsx",
        start: 0,
        end: 11,
        selection: { startLine: 10, startChar: 0, endLine: 20, endChar: 5 },
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\App.tsx",
      messageID: "msg_sel",
      sessionID: "ses_sel",
      sessionDirectory: "C:\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should have query parameters
      expect(filePart.url).toContain("?start=10&end=20")
      // Should be valid URL
      expect(() => new URL(filePart.url)).not.toThrow()
      // Query params should parse correctly
      const url = new URL(filePart.url)
      expect(url.searchParams.get("start")).toBe("10")
      expect(url.searchParams.get("end")).toBe("20")
    }
  })

  test("handles file paths with dots and special segments on Windows", () => {
    const prompt: Prompt = [
      { type: "file", path: "..\\..\\shared\\util.ts", content: "@..\\..\\shared\\util.ts", start: 0, end: 21 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@..\\..\\shared\\util.ts",
      messageID: "msg_dots",
      sessionID: "ses_dots",
      sessionDirectory: "C:\\projects\\myapp\\src",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should be valid URL
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should preserve .. segments (backend normalizes)
      expect(filePart.url).toContain("/..")
    }
  })
})

describe("attachment chips", () => {
  test("maps a chip to a path-backed file request part", () => {
    const prompt: Prompt = [
      { type: "text", content: "look at this", start: 0, end: 12 },
      {
        type: "attachment",
        id: "att_1",
        path: "/Users/me/photo.png",
        filename: "photo.png",
        mime: "image/png",
        size: 2048,
      },
    ]

    const parts = buildAttachmentRequestParts({ prompt, images: [], sessionDirectory: "/repo" })

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "file",
      mime: "text/plain",
      url: "file:///Users/me/photo.png",
      filename: "photo.png",
      // The tag is what lets the sent bubble show the chip — context items
      // share this wire shape and must stay untagged.
      metadata: { attachment: true },
    })
  })

  test("optimistic parts keep the chip attachment tag", () => {
    const prompt: Prompt = [
      { type: "text", content: "hi", start: 0, end: 2 },
      { type: "attachment", id: "att_1", path: "/Users/me/guide.pdf", filename: "guide.pdf" },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "hi",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    const optimisticFile = result.optimisticParts.find((part) => part.type === "file")
    expect(optimisticFile).toMatchObject({ metadata: { attachment: true } })
  })

  test("collapses a chip and an inline pill that reference the same path", () => {
    const prompt: Prompt = [
      { type: "file", path: "/Users/me/notes.md", content: "@notes.md", start: 0, end: 9 },
      { type: "attachment", id: "att_1", path: "/Users/me/notes.md", filename: "notes.md" },
    ]

    const parts = buildAttachmentRequestParts({ prompt, images: [], sessionDirectory: "/repo" })

    expect(parts.filter((part) => part.type === "file")).toHaveLength(1)
  })

  // The composer's duplicate guard compares raw paths and can show a redundant
  // chip next to a relative pill for the same file; this pins the compensating
  // guarantee that the request still carries the reference exactly once.
  test("collapses a relative inline pill and an absolute chip for the same file", () => {
    const prompt: Prompt = [
      { type: "file", path: "src/foo.ts", content: "@src/foo.ts", start: 0, end: 11 },
      { type: "attachment", id: "att_1", path: "/repo/src/foo.ts", filename: "foo.ts" },
    ]

    const parts = buildAttachmentRequestParts({ prompt, images: [], sessionDirectory: "/repo" })

    const fileParts = parts.filter((part) => part.type === "file")
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0]).toMatchObject({ url: "file:///repo/src/foo.ts" })
  })

  test("includes chips in full request builds", () => {
    const prompt: Prompt = [
      { type: "text", content: "hi", start: 0, end: 2 },
      { type: "attachment", id: "att_1", path: "/Users/me/guide.pdf", filename: "guide.pdf" },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "hi",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    const fileParts = result.requestParts.filter((part) => part.type === "file")
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0]).toMatchObject({ url: "file:///Users/me/guide.pdf", filename: "guide.pdf" })
  })

  test("dedupes context items against chips in full request builds", () => {
    const prompt: Prompt = [
      { type: "text", content: "hi", start: 0, end: 2 },
      { type: "attachment", id: "att_1", path: "/Users/me/guide.pdf", filename: "guide.pdf" },
    ]

    const result = buildRequestParts({
      prompt,
      context: [{ key: "ctx:1", type: "file", path: "/Users/me/guide.pdf" }],
      images: [],
      text: "hi",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    expect(result.requestParts.filter((part) => part.type === "file")).toHaveLength(1)
  })
})
