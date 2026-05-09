import { describe, expect, test } from "bun:test"
import { AccountTransportError } from "../../src/account/schema"
import { CliError } from "../../src/cli/effect-cmd"
import { FormatError } from "../../src/cli/error"

describe("cli.error", () => {
  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://console.opencode.ai/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://console.opencode.ai/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })

  test("formats ProviderModelNotFoundError from named-error payloads", () => {
    const formatted = FormatError({
      name: "ProviderModelNotFoundError",
      data: {
        providerID: "openai",
        modelID: "gpt-bad",
        suggestions: ["gpt-5"],
      },
    })

    expect(formatted).toContain("Model not found: openai/gpt-bad")
    expect(formatted).toContain("Did you mean: gpt-5")
    expect(formatted).toContain("opencode models")
    expect(formatted).toContain("pawwork.json")
  })

  test("formats effectCmd CliError", () => {
    const formatted = FormatError(new CliError({ message: "Provider not found: missing" }))

    expect(formatted).toBe("Provider not found: missing")
  })
})
