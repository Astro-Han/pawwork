import { describe, expect, test } from "bun:test"

import { IMAGE_EXTS } from "@opencode-ai/util/file-extensions"

import { attachmentPathMime, MIME_BY_EXTENSION } from "./attachment-mime"

describe("attachmentPathMime", () => {
  test("returns MIME types for direct attachment files", () => {
    expect(attachmentPathMime("/tmp/image.gif")).toBe("image/gif")
    expect(attachmentPathMime("/tmp/image.jpeg")).toBe("image/jpeg")
    expect(attachmentPathMime("/tmp/image.png")).toBe("image/png")
    expect(attachmentPathMime("/tmp/image.JPG")).toBe("image/jpeg")
    expect(attachmentPathMime("/tmp/image.webp")).toBe("image/webp")
    expect(attachmentPathMime("/tmp/document.pdf")).toBe("application/pdf")
  })

  test("returns MIME types using an injected extension reader", () => {
    const extname = (filepath: string) => filepath.slice(filepath.lastIndexOf("."))

    expect(attachmentPathMime("C:\\tmp\\image.PNG", extname)).toBe("image/png")
  })

  test("keeps image MIME entries in sync with the renderer contract", () => {
    const imageEntries = [...MIME_BY_EXTENSION.entries()]
      .filter(([extension]) => extension !== "pdf")
      .sort(([left], [right]) => left.localeCompare(right))

    const rendererImageEntries = [...IMAGE_EXTS.entries()].sort(([left], [right]) => left.localeCompare(right))

    expect(imageEntries).toEqual(rendererImageEntries)
  })

  test("returns undefined for unsupported extensions", () => {
    expect(attachmentPathMime("/tmp/archive.zip")).toBeUndefined()
  })

  test("returns undefined for missing extensions", () => {
    expect(attachmentPathMime("/tmp/no-extension")).toBeUndefined()
  })
})
