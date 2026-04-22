import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { pickAttachments } from "./pick-attachments"

const originalWarn = console.warn
const originalError = console.error
let warn: ReturnType<typeof mock>
let error: ReturnType<typeof mock>

beforeEach(() => {
  warn = mock(() => undefined)
  error = mock(() => undefined)
  console.warn = warn as typeof console.warn
  console.error = error as typeof console.error
})

afterEach(() => {
  console.warn = originalWarn
  console.error = originalError
})

describe("pickAttachments", () => {
  test("uses native picker with broad filters", async () => {
    const calls: unknown[] = []
    const picked: string[][] = []

    await pickAttachments({
      openFilePickerDialog: async (opts) => {
        calls.push(opts)
        return "/tmp/report.docx"
      },
      addPickedPaths: async (paths) => {
        picked.push(paths)
        return true
      },
      fallbackInputClick: () => {
        throw new Error("browser fallback should not run")
      },
    })

    expect(calls).toEqual([{ multiple: true, extensions: [] }])
    expect(picked).toEqual([["/tmp/report.docx"]])
  })

  test("passes through multiple native picker results", async () => {
    const picked: string[][] = []

    await pickAttachments({
      openFilePickerDialog: async () => ["/tmp/a.docx", "/tmp/b.xlsx"],
      addPickedPaths: async (paths) => {
        picked.push(paths)
        return true
      },
      fallbackInputClick: () => {},
    })

    expect(picked).toEqual([["/tmp/a.docx", "/tmp/b.xlsx"]])
  })

  test("does nothing when native picker is canceled", async () => {
    let called = false

    await pickAttachments({
      openFilePickerDialog: async () => null,
      addPickedPaths: async () => {
        called = true
        return true
      },
      fallbackInputClick: () => {},
    })

    expect(called).toBe(false)
  })

  test("ignores empty native picker paths", async () => {
    let called = false

    const result = await pickAttachments({
      openFilePickerDialog: async () => ["", ""],
      addPickedPaths: async () => {
        called = true
        return true
      },
      fallbackInputClick: () => {},
    })

    expect(result).toBe(false)
    expect(called).toBe(false)
  })

  test("uses browser fallback when native picker is unavailable", async () => {
    let clicked = false

    await pickAttachments({
      addPickedPaths: async () => {
        throw new Error("native path handler should not run")
      },
      fallbackInputClick: () => {
        clicked = true
      },
    })

    expect(clicked).toBe(true)
  })

  test("uses browser fallback when native picker rejects", async () => {
    let clicked = false

    await pickAttachments({
      openFilePickerDialog: async () => {
        throw new Error("dialog failed")
      },
      addPickedPaths: async () => {
        throw new Error("native path handler should not run")
      },
      fallbackInputClick: () => {
        clicked = true
      },
    })

    expect(clicked).toBe(true)
    expect(warn).toHaveBeenCalled()
  })

  test("handles picked path failures", async () => {
    const result = await pickAttachments({
      openFilePickerDialog: async () => "/tmp/report.docx",
      addPickedPaths: async () => {
        throw new Error("attach failed")
      },
      fallbackInputClick: () => {
        throw new Error("browser fallback should not run")
      },
    })

    expect(result).toBe(false)
    expect(error).toHaveBeenCalled()
  })
})
