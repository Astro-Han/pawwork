import { describe, expect, test } from "bun:test"
import { parseMcpToolResult } from "../../src/session/prompt"

describe("parseMcpToolResult", () => {
  test("returns ok with text and attachments for a successful result", () => {
    const parsed = parseMcpToolResult("server_tool", {
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "aGk=" },
        { type: "resource", resource: { uri: "res://a", text: "resource text" } },
      ],
    })
    expect(parsed.kind).toBe("ok")
    if (parsed.kind !== "ok") return
    expect(parsed.textParts).toEqual(["hello", "resource text"])
    expect(parsed.attachments).toEqual([{ type: "file", mime: "image/png", url: "data:image/png;base64,aGk=" }])
  })

  test("returns error with the text content when isError is set", () => {
    const parsed = parseMcpToolResult("server_tool", {
      isError: true,
      content: [{ type: "text", text: "tool exploded: bad input" }],
    })
    expect(parsed).toEqual({ kind: "error", message: "tool exploded: bad input" })
  })

  test("returns a fallback message when isError carries no text", () => {
    const parsed = parseMcpToolResult("server_tool", { isError: true, content: [] })
    expect(parsed).toEqual({ kind: "error", message: "MCP tool server_tool reported an error without details" })
  })

  test("isError false behaves like success", () => {
    const parsed = parseMcpToolResult("server_tool", {
      isError: false,
      content: [{ type: "text", text: "fine" }],
    })
    expect(parsed.kind).toBe("ok")
  })
})
