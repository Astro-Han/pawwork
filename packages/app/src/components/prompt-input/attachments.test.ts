import { Buffer } from "node:buffer"
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as uiToast from "@opencode-ai/ui/toast"
import { attachmentMime } from "./files"
import { pasteMode } from "./paste"
import type { createPromptAttachments as createPromptAttachmentsType } from "./attachments"

const toasts: Array<{ title?: string; description?: string; actions?: Array<{ label: string; onClick: () => void }> }> = []
let promptParts: unknown[] = []
let createPromptAttachments: typeof createPromptAttachmentsType
let fileReaderDataUrl: string | undefined
const originalFileReader = globalThis.FileReader

class TestFileReader {
  result: string | null = null
  private listeners = new Map<string, Array<() => void>>()

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  async readAsDataURL(file: File) {
    const payload = Buffer.from(await file.arrayBuffer()).toString("base64")
    this.result = fileReaderDataUrl ?? `data:${file.type || "application/octet-stream"};base64,${payload}`
    for (const listener of this.listeners.get("load") ?? []) listener()
  }
}

// spyOn + afterAll restore instead of mock.module: bun's mock.module is a
// global, persistent, non-restoring registry override that leaked this toast
// mock into every later test file and broke suites relying on the real
// showToast (e.g. pawwork-session-commands.test.ts).
spyOn(uiToast, "showToast").mockImplementation((toast) => {
  toasts.push(toast as (typeof toasts)[number])
  return 0
})

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

mock.module("@/context/prompt", () => ({
  DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
  isFloatingAttachment: (part: { type: string }) => part.type === "image" || part.type === "attachment",
  isStructurallyEmpty: (parts: unknown[], contextItems: unknown[], imageAttachments: unknown[]) =>
    (parts.length === 0 ||
      (parts.length === 1 &&
        typeof parts[0] === "object" &&
        parts[0] !== null &&
        "type" in parts[0] &&
        parts[0].type === "text" &&
        "content" in parts[0] &&
        parts[0].content === "")) &&
    contextItems.length === 0 &&
    imageAttachments.length === 0,
  usePrompt: () => ({
    current: () => promptParts,
    cursor: () => 0,
    set: (parts: unknown[]) => {
      promptParts = parts
    },
  }),
}))

beforeAll(async () => {
  ;(globalThis as unknown as { FileReader: typeof TestFileReader }).FileReader = TestFileReader
  createPromptAttachments = (await import("./attachments")).createPromptAttachments
})

afterAll(() => {
  ;(globalThis as unknown as { FileReader: typeof originalFileReader }).FileReader = originalFileReader
  mock.restore()
})

beforeEach(() => {
  toasts.length = 0
  promptParts = []
  fileReaderDataUrl = undefined
})

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("uses image suffix fallback when the browser reports octet-stream", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "photo.png", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("image/png")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})

describe("createPromptAttachments", () => {
  test("adds picked media paths as deduped attachment chips instead of inline pills", async () => {
    const addedParts: unknown[] = []
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => ({
        capabilities: {
          input: {
            image: true,
            pdf: true,
          },
        },
      }),
      openModelSelector: () => undefined,
      readFileDataUrl: async () => "data:image/png;base64,aW1hZ2U=",
    })

    const result = await attachments.addPickedPaths([
      "/Users/me/image.png",
      "/Users/me/report.pdf",
      "/Users/me/image.png",
    ])

    expect(result).toBe(true)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      { type: "attachment", path: "/Users/me/image.png", filename: "image.png", mime: "image/png" },
      { type: "attachment", path: "/Users/me/report.pdf", filename: "report.pdf", mime: "application/pdf" },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("adds desktop dropped files from Electron file paths", async () => {
    const addedParts: unknown[] = []
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => ({
        capabilities: {
          input: {
            pdf: false,
          },
        },
      }),
      openModelSelector: () => undefined,
      filePathForBrowserFile: async () => "/Users/me/guide.pdf",
    })

    const result = await attachments.addAttachments([new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })])

    expect(result).toBe(true)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      { type: "attachment", path: "/Users/me/guide.pdf", filename: "guide.pdf", mime: "application/pdf" },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("stores file sizes on path-backed attachments when available", async () => {
    const addedParts: unknown[] = []
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => undefined,
      openModelSelector: () => undefined,
      statPaths: async () => ({ "/Users/me/guide.pdf": { exists: true, size: 1536 } }),
    })

    const result = await attachments.addPickedPath("/Users/me/guide.pdf")

    expect(result).toBe(true)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      { type: "attachment", path: "/Users/me/guide.pdf", filename: "guide.pdf", size: 1536 },
    ])
  })

  test("saves pathless pasted files before attaching them", async () => {
    const addedParts: unknown[] = []
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => ({
        capabilities: {
          input: {
            image: true,
          },
        },
      }),
      openModelSelector: () => undefined,
      saveAttachmentFile: async () => "/Users/me/Library/Application Support/PawWork/attachments/pasted-image.png",
    })

    const result = await attachments.addAttachment(new File(["image"], "pasted-image.png", { type: "image/png" }))

    expect(result).toBe(true)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      {
        type: "attachment",
        path: "/Users/me/Library/Application Support/PawWork/attachments/pasted-image.png",
        filename: "pasted-image.png",
        mime: "image/png",
      },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("reports a skipped file even when another dropped file is attached", async () => {
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => ({
        capabilities: {
          input: {
            image: false,
          },
        },
      }),
      openModelSelector: () => undefined,
    })

    const result = await attachments.addAttachments([
      new File(["hello"], "note.txt", { type: "text/plain" }),
      new File(["image"], "image.png", { type: "image/png" }),
    ])

    expect(result).toBe(true)
    expect(promptParts).toHaveLength(1)
    expect(toasts.map((toast) => toast.title)).toEqual(["prompt.toast.imageUnsupported.title"])
  })

  test("does not block picked image paths on model media support", async () => {
    const addedParts: unknown[] = []
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => ({
        capabilities: {
          input: {
            image: false,
          },
        },
      }),
      openModelSelector: () => undefined,
    })

    const result = await attachments.addPickedPaths(["/Users/me/report.docx", "/Users/me/image.png"])

    expect(result).toBe(true)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      { type: "attachment", path: "/Users/me/report.docx", filename: "report.docx" },
      { type: "attachment", path: "/Users/me/image.png", filename: "image.png" },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("does not read picked media paths as data URL attachments", async () => {
    const addedParts: unknown[] = []
    let readCalls = 0
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => ({
        capabilities: {
          input: {
            image: true,
          },
        },
      }),
      openModelSelector: () => undefined,
      readFileDataUrl: async () => {
        readCalls++
        throw new Error("read failed")
      },
    })

    const result = await attachments.addPickedPath("/Users/me/image.png")

    expect(result).toBe(true)
    expect(readCalls).toBe(0)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      { type: "attachment", path: "/Users/me/image.png", filename: "image.png", mime: "image/png" },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("keeps picked path batches on the file-reference path", async () => {
    const addedParts: unknown[] = []
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      model: () => ({
        capabilities: {
          input: {
            image: true,
          },
        },
      }),
      openModelSelector: () => undefined,
      readFileDataUrl: async () => null,
    })

    const result = await attachments.addPickedPaths(["/Users/me/report.docx", "/Users/me/image.png"])

    expect(result).toBe(true)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toMatchObject([
      { type: "attachment", path: "/Users/me/report.docx", filename: "report.docx" },
      { type: "attachment", path: "/Users/me/image.png", filename: "image.png" },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("skips adding a chip when an inline pill already references the same path", async () => {
    promptParts = [{ type: "file", path: "/Users/me/guide.pdf", content: "@guide.pdf", start: 0, end: 10 }]
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => undefined,
      openModelSelector: () => undefined,
    })

    const result = await attachments.addPickedPath("/Users/me/guide.pdf")

    expect(result).toBe(true)
    expect(promptParts).toHaveLength(1)
    expect(toasts).toHaveLength(0)
  })

  test("removeAttachment removes chip parts by id", async () => {
    promptParts = [
      { type: "text", content: "hi", start: 0, end: 2 },
      { type: "attachment", id: "att_1", path: "/Users/me/a.pdf", filename: "a.pdf" },
      { type: "image", id: "img_1", filename: "b.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => undefined,
      openModelSelector: () => undefined,
    })

    attachments.removeAttachment("att_1")
    expect(promptParts.map((part) => (part as { id?: string }).id ?? "text")).toEqual(["text", "img_1"])

    attachments.removeAttachment("img_1")
    expect(promptParts).toHaveLength(1)
  })

  test("accepts empty FileReader MIME when the routed MIME is known", async () => {
    fileReaderDataUrl = "data:;base64,aGVsbG8="
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => ({
        capabilities: {
          input: {
            image: true,
          },
        },
      }),
      openModelSelector: () => undefined,
    })

    const result = await attachments.addAttachment(new File(["image"], "image.png", { type: "image/png" }))

    expect(result).toBe(true)
    expect(promptParts).toEqual([
      {
        type: "image",
        id: expect.any(String),
        filename: "image.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    ])
    expect(toasts).toHaveLength(0)
  })

  test("handleGlobalDrop cancels native drop before bailing when externalReady is false", async () => {
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => ({ capabilities: { input: { image: true } } }),
      openModelSelector: () => undefined,
      externalReady: () => false,
    })

    let prevented = false
    const fakeEvent = {
      preventDefault: () => {
        prevented = true
      },
      dataTransfer: { files: [], getData: () => "" },
    } as unknown as DragEvent

    await attachments.handleGlobalDrop(fakeEvent)

    expect(prevented).toBe(true)
    expect(promptParts).toHaveLength(0)
  })

  test("handlePaste skips native clipboard image when externalReady is false", async () => {
    let readCalls = 0
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => ({ capabilities: { input: { image: true } } }),
      openModelSelector: () => undefined,
      externalReady: () => false,
      readClipboardImage: async () => {
        readCalls++
        return new File(["image"], "screenshot.png", { type: "image/png" })
      },
    })

    const fakeEvent = {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      clipboardData: {
        items: [],
        getData: () => "",
      },
    } as unknown as ClipboardEvent

    await attachments.handlePaste(fakeEvent)

    expect(readCalls).toBe(0)
    expect(promptParts).toHaveLength(0)
  })

  test("reports direct attachment read failures in dropped file batches", async () => {
    fileReaderDataUrl = "data:;base64,not-base64"
    const attachments = createPromptAttachments({
      editor: () => ({}) as HTMLDivElement,
      isDialogActive: () => false,
      setDraggingType: () => undefined,
      focusEditor: () => undefined,
      addPart: () => true,
      model: () => ({
        capabilities: {
          input: {
            image: true,
          },
        },
      }),
      openModelSelector: () => undefined,
    })

    const result = await attachments.addAttachments([new File(["image"], "image.png", { type: "image/png" })])

    expect(result).toBe(false)
    expect(promptParts).toHaveLength(0)
    expect(toasts.map((toast) => toast.title)).toEqual(["prompt.toast.pasteUnsupported.title"])
  })
})
