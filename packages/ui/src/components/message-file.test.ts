import { describe, expect, test } from "bun:test"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { attached, chip, inline, kind } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("treats data URLs as attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
    expect(attached(file())).toBe(false)
  })

  test("treats only non-attachment source ranges as inline references", () => {
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(true)

    expect(
      inline(
        file({
          url: "data:text/plain;base64,SGVsbG8=",
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)
  })

  test("recognises composer chips by their attachment metadata", () => {
    // Floating composer chips submit as source-less file:// parts tagged
    // metadata.attachment so the bubble can show them; context-item parts
    // share the wire shape but carry no tag and stay hidden.
    expect(chip(file({ metadata: { attachment: true } }))).toBe(true)
    expect(chip(file())).toBe(false)
    expect(chip(file({ url: "data:text/plain;base64,SGVsbG8=", metadata: { attachment: true } }))).toBe(false)
    expect(
      chip(
        file({
          metadata: { attachment: true },
          source: { type: "file", path: "/repo/README.txt", text: { value: "@README.txt", start: 0, end: 11 } },
        }),
      ),
    ).toBe(false)
  })

  test("separates image and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })
})
