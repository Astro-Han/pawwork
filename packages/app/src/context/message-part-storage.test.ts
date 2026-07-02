import { describe, expect, test } from "bun:test"
import { shouldStoreMessagePart } from "./message-part-storage"
import type { Part } from "@opencode-ai/sdk/v2/client"

const part = (type: Part["type"]) => ({ type }) as Pick<Part, "type">

describe("shouldStoreMessagePart", () => {
  test("skips transient message part types that are not rendered from stored state", () => {
    expect(shouldStoreMessagePart(part("patch"))).toBe(false)
    expect(shouldStoreMessagePart(part("step-start"))).toBe(false)
    expect(shouldStoreMessagePart(part("step-finish"))).toBe(false)
  })

  test("keeps durable message part types", () => {
    expect(shouldStoreMessagePart(part("text"))).toBe(true)
    expect(shouldStoreMessagePart(part("tool"))).toBe(true)
  })
})
