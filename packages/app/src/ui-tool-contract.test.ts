import { describe, expect, it } from "bun:test"
import {
  HIDDEN_TOOL_NAMES,
  TOOL_QUESTION,
  TOOL_TODOWRITE,
  TOOL_WEBFETCH,
  TOOL_WEBSEARCH,
} from "@opencode-ai/ui/tool-contract"

describe("@opencode-ai/ui/tool-contract public import", () => {
  it("exposes the tool names app status extractors depend on", () => {
    expect(TOOL_TODOWRITE).toBe("todowrite")
    expect(TOOL_WEBFETCH).toBe("webfetch")
    expect(TOOL_WEBSEARCH).toBe("websearch")
    expect(TOOL_QUESTION).toBe("question")
    expect(HIDDEN_TOOL_NAMES).toEqual(["todowrite"])
  })
})
