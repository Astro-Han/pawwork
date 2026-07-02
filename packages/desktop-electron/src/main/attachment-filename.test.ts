import { describe, expect, test } from "bun:test"
import { safeAttachmentName } from "./attachment-filename"

describe("safeAttachmentName", () => {
  test("replaces invalid filename characters", () => {
    expect(safeAttachmentName('a<b>:"|?*.txt')).toBe("a_b______.txt")
  })

  test("removes trailing dots and spaces for Windows compatibility", () => {
    expect(safeAttachmentName("report.pdf. ")).toBe("report.pdf")
  })

  test("prefixes Windows reserved basenames", () => {
    expect(safeAttachmentName("CON")).toBe("_CON")
    expect(safeAttachmentName("nul.txt")).toBe("_nul.txt")
    expect(safeAttachmentName("LPT1")).toBe("_LPT1")
  })

  test("falls back when the sanitized name is empty", () => {
    expect(safeAttachmentName("... ")).toBe("attachment")
    expect(safeAttachmentName("")).toBe("attachment")
  })
})
