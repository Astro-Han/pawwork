import { Buffer } from "node:buffer"
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
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

mock.module("@opencode-ai/ui/toast", () => ({
  showToast: (toast: (typeof toasts)[number]) => {
    toasts.push(toast)
  },
}))

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

mock.module("@/context/prompt", () => ({
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

  test("reports a skipped picked path even when another picked path is attached", async () => {
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
    expect(addedParts).toHaveLength(1)
    expect(toasts.map((toast) => toast.title)).toEqual(["prompt.toast.imageUnsupported.title"])
  })

  test("does not downgrade picked direct media read failures to path mentions", async () => {
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

    const result = await attachments.addPickedPath("/Users/me/image.png")

    expect(result).toBe(false)
    expect(addedParts).toHaveLength(0)
    expect(promptParts).toHaveLength(0)
    expect(toasts.map((toast) => toast.title)).toEqual(["prompt.toast.pasteUnsupported.title"])
  })

  test("reports thrown picked direct read failures", async () => {
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
      readFileDataUrl: async () => {
        throw new Error("read failed")
      },
    })

    const result = await attachments.addPickedPath("/Users/me/image.png")

    expect(result).toBe(false)
    expect(promptParts).toHaveLength(0)
    expect(toasts.map((toast) => toast.title)).toEqual(["prompt.toast.pasteUnsupported.title"])
  })

  test("reports picked direct read failures in path batches", async () => {
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
    expect(addedParts).toHaveLength(1)
    expect(toasts.map((toast) => toast.title)).toEqual(["prompt.toast.pasteUnsupported.title"])
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
