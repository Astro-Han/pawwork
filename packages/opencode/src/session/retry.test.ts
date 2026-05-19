import { describe, expect, test } from "bun:test"
import { MessageV2 } from "./message-v2"
import { ProviderID } from "@/provider/schema"

describe("APIError schema", () => {
  test("parses historical JSON without providerID", () => {
    const result = MessageV2.APIError.Schema.parse({
      name: "APIError",
      data: {
        message: "boom",
        isRetryable: false,
        statusCode: 500,
      },
    })
    expect(result.data.providerID).toBeUndefined()
  })

  test("preserves providerID when present", () => {
    const result = MessageV2.APIError.Schema.parse({
      name: "APIError",
      data: {
        message: "boom",
        isRetryable: false,
        providerID: ProviderID.opencode,
      },
    })
    expect(result.data.providerID).toBe("opencode")
  })
})
