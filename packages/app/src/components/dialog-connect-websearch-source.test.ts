import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./dialog-connect-websearch.tsx", import.meta.url), "utf8")

describe("dialog-connect-websearch source contract", () => {
  test("exports DialogConnectWebSearch", () => {
    expect(source).toContain("export function DialogConnectWebSearch")
  })

  test("renders all four state branches", () => {
    // anonymous default state
    expect(source).toContain('source === "anonymous"')
    expect(source).toContain("quotaExceeded")
    // env read-only state
    expect(source).toContain('source === "env"')
    // saved states (healthy and needsAttention both match on source === "saved")
    expect(source).toContain('source === "saved"')
    // needsAttention branch
    expect(source).toContain("needsAttention")
  })

  test("does not fabricate anonymous status before status loads", () => {
    expect(source).not.toContain('source: "anonymous" as const')
    expect(source).toContain("webSearchStatusResource.error")
    expect(source).toContain("dialog.websearch.status.loading")
    expect(source).toContain("dialog.websearch.status.error")
  })

  test("calls window.api saveExaApiKey and removeExaApiKey", () => {
    expect(source).toMatch(/window\.api[\s\S]{0,40}saveExaApiKey/)
    expect(source).toMatch(/window\.api[\s\S]{0,40}removeExaApiKey/)
  })

  test("notifies the parent settings row after save or remove", () => {
    expect(source).toContain("onStatusChanged")
    expect(source.match(/props\.onStatusChanged\?\.\(\)/g)?.length).toBe(2)
  })

  test("prioritizes saved quota over saved invalid-key attention in the title", () => {
    const quotaTitle = source.indexOf('dialog.websearch.title.savedQuota')
    const failedTitle = source.indexOf('dialog.websearch.title.failed')

    expect(quotaTitle).toBeGreaterThan(-1)
    expect(failedTitle).toBeGreaterThan(-1)
    expect(quotaTitle).toBeLessThan(failedTitle)
  })

  test("imports Dialog from @opencode-ai/ui/dialog (visual pattern reuse)", () => {
    expect(source).toContain('from "@opencode-ai/ui/dialog"')
  })

  test("does NOT import useProviders or globalSDK (Exa is not an LLM provider)", () => {
    expect(source).not.toContain("useProviders")
    expect(source).not.toContain("globalSDK")
  })
})
