import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { formatProviderConnectError } from "./dialog-connect-provider-error"

const dialogSource = readFileSync(new URL("./dialog-connect-provider.tsx", import.meta.url), "utf8")
const authViewsSource = readFileSync(new URL("./dialog-connect-provider-auth-views.tsx", import.meta.url), "utf8")
const autoViewSource = readFileSync(new URL("./dialog-connect-provider-auto-view.tsx", import.meta.url), "utf8")
const promptViewSource = readFileSync(new URL("./dialog-connect-provider-prompt-view.tsx", import.meta.url), "utf8")
const errorSource = readFileSync(new URL("./dialog-connect-provider-error.ts", import.meta.url), "utf8")

describe("dialog-connect-provider source boundary", () => {
  test("keeps auth views and error formatting in owner files", () => {
    expect(dialogSource).toContain("ProviderApiAuthView")
    expect(dialogSource).toContain("ProviderOAuthCodeView")
    expect(dialogSource).toContain("ProviderOAuthAutoView")
    expect(dialogSource).toContain("ProviderOAuthPromptsView")
    expect(authViewsSource).toContain("export function ProviderApiAuthView")
    expect(authViewsSource).toContain("export function ProviderOAuthCodeView")
    expect(autoViewSource).toContain("export function ProviderOAuthAutoView")
    expect(promptViewSource).toContain("export function ProviderOAuthPromptsView")
    expect(errorSource).toContain("export function formatProviderConnectError")
  })

  test("preserves provider auth copy and action wiring after extraction", () => {
    for (const key of ["provider.connect.apiKey.required", "provider.connect.oauth.code.required"]) {
      expect(authViewsSource).toContain(key)
    }

    for (const key of ["provider.connect.oauth.auto.confirmationCode", "provider.connect.status.waiting"]) {
      expect(autoViewSource).toContain(key)
    }

    expect(promptViewSource).toContain("prompt.when")
    expect(dialogSource).toContain("globalSDK.client.provider.oauth")
    expect(dialogSource).toContain(".authorize(")
    expect(dialogSource).toContain("actionClient.global.dispose")
    expect(dialogSource).toContain("provider.connect.toast.connected.deferredDescription")
  })

  test("tags provider connect lifecycle dispose calls with client action headers", () => {
    expect(dialogSource).toContain("clientActionHeaders")
    expect(dialogSource).toContain('kind: "settings.provider.connect"')
    expect(dialogSource).toContain("actionClient.global.dispose")
  })

  test("formats nested provider auth errors without losing fallback behavior", () => {
    expect(formatProviderConnectError({ data: { message: "data failed" } }, "fallback")).toBe("data failed")
    expect(formatProviderConnectError({ error: { message: "nested failed" } }, "fallback")).toBe("nested failed")
    expect(formatProviderConnectError(new Error("error failed"), "fallback")).toBe("error failed")
    expect(formatProviderConnectError("", "fallback")).toBe("fallback")
  })
})
