import { describe, expect, test } from "bun:test"
import { submitProviderApiAuth } from "./dialog-connect-provider-api-auth"

describe("submitProviderApiAuth", () => {
  test("completes after a successful api auth write", async () => {
    const calls: string[] = []
    const error = await submitProviderApiAuth({
      setAuth: async () => {
        calls.push("setAuth")
      },
      onComplete: async () => {
        calls.push("onComplete")
      },
      formatError: () => "failed",
    })

    expect(error).toBeUndefined()
    expect(calls).toEqual(["setAuth", "onComplete"])
  })

  test("returns a form error without completing when api auth write fails", async () => {
    const calls: string[] = []
    const error = await submitProviderApiAuth({
      setAuth: async () => {
        calls.push("setAuth")
        throw new Error("bad key")
      },
      onComplete: async () => {
        calls.push("onComplete")
      },
      formatError: (value) => (value instanceof Error ? value.message : "failed"),
    })

    expect(error).toBe("bad key")
    expect(calls).toEqual(["setAuth"])
  })
})
