import { describe, expect, test } from "bun:test"
import { getProviderOAuthSelectPromptState } from "./dialog-connect-provider-prompt-state"

describe("getProviderOAuthSelectPromptState", () => {
  test("preserves the active prompt index when adding a selected value", () => {
    const state = getProviderOAuthSelectPromptState(
      {
        index: 2,
        prompt: {
          type: "select",
          key: "region",
          message: "Region",
          options: [{ label: "US", value: "us" }],
        },
      },
      { value: "us" },
      { account: "work" },
    )

    expect(state).toEqual({
      index: 2,
      value: {
        account: "work",
        region: "us",
      },
    })
  })

  test("does not continue non-select prompts through the select path", () => {
    const state = getProviderOAuthSelectPromptState(
      {
        index: 1,
        prompt: {
          type: "text",
          key: "token",
          message: "Token",
        },
      },
      { value: "us" },
      {},
    )

    expect(state).toBeUndefined()
  })
})
