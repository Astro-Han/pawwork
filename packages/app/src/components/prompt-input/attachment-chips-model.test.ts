import { describe, expect, test } from "bun:test"
import { attachmentChipModel, formatFileSize } from "./attachment-chips-model"

describe("formatFileSize", () => {
  test("formats bytes, KB and MB", () => {
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(1536)).toBe("1.5 KB")
    expect(formatFileSize(3.4 * 1024 * 1024)).toBe("3.4 MB")
  })

  test("returns empty string for unknown sizes", () => {
    expect(formatFileSize(undefined)).toBe("")
    expect(formatFileSize(-1)).toBe("")
  })
})

describe("attachmentChipModel", () => {
  test("path-backed image chips render as image kind with path and tooltip", () => {
    const model = attachmentChipModel({
      type: "attachment",
      id: "att_1",
      path: "/Users/me/shot.png",
      filename: "shot.png",
      mime: "image/png",
      size: 2048,
    })

    expect(model).toEqual({
      id: "att_1",
      kind: "image",
      filename: "shot.png",
      path: "/Users/me/shot.png",
      mime: "image/png",
      sizeText: "2 KB",
      tooltip: "/Users/me/shot.png\n2 KB",
    })
  })

  test("path-backed non-image chips render as file kind", () => {
    const model = attachmentChipModel({
      type: "attachment",
      id: "att_2",
      path: "/Users/me/Q3-report.pdf",
      filename: "Q3-report.pdf",
      mime: "application/pdf",
    })

    expect(model.kind).toBe("file")
    expect(model.path).toBe("/Users/me/Q3-report.pdf")
    expect(model.sizeText).toBe("")
    expect(model.tooltip).toBe("/Users/me/Q3-report.pdf")
  })

  test("legacy data-URL images render as image kind without a path", () => {
    const model = attachmentChipModel({
      type: "image",
      id: "img_1",
      filename: "paste.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AAA",
    })

    expect(model.kind).toBe("image")
    expect(model.path).toBeUndefined()
    expect(model.legacyDataUrl).toBe("data:image/png;base64,AAA")
    expect(model.tooltip).toBe("paste.png")
  })

  test("legacy non-image data-URL attachments render as file kind", () => {
    const model = attachmentChipModel({
      type: "image",
      id: "img_2",
      filename: "notes.txt",
      mime: "text/plain",
      dataUrl: "data:text/plain;base64,AAA",
    })

    expect(model.kind).toBe("file")
    expect(model.legacyDataUrl).toBeUndefined()
  })
})
