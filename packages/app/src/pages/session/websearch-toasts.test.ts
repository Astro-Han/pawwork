import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { webSearchRecoveryToast } from "./websearch-toasts"

function part(input: { id?: string; callID?: string; kind: string; source: string; status?: number; key?: string }) {
  return {
    id: input.id ?? "part-1",
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "tool",
    tool: "websearch",
    callID: input.callID,
    state: {
      status: "error",
      input: { query: "latest PawWork" },
      error: "search failed",
      metadata: {
        webSearch: {
          failure: {
            kind: input.kind,
            source: input.source,
            status: input.status,
            key: input.key,
          },
        },
      },
    },
  } as unknown as Part
}

describe("webSearchRecoveryToast", () => {
  test("builds an actionable quota toast without copying key material", () => {
    const surfaced = new Set<string>()
    const toast = webSearchRecoveryToast(
      part({ callID: "call-1", kind: "quota_exceeded", source: "saved", key: "sk-secret-123" }),
      {
        surfaced,
      },
    )

    expect(toast).toEqual({
      id: "call-1",
      titleKey: "toast.websearch.quota.title",
      descriptionKey: "toast.websearch.savedQuota.description",
      actionKey: "toast.websearch.action.openSettings",
    })
    expect(JSON.stringify(toast)).not.toContain("key")
    expect(JSON.stringify(toast)).not.toContain("sk-secret")
  })

  test("dedupes by call id permanently for the surfaced failure", () => {
    const surfaced = new Set<string>()
    const first = webSearchRecoveryToast(part({ callID: "call-2", kind: "invalid_key", source: "saved" }), {
      surfaced,
    })
    const duplicate = webSearchRecoveryToast(part({ callID: "call-2", kind: "invalid_key", source: "saved" }), {
      surfaced,
    })
    const later = webSearchRecoveryToast(part({ callID: "call-2", kind: "invalid_key", source: "saved" }), {
      surfaced,
    })

    expect(first?.titleKey).toBe("toast.websearch.invalidKey.title")
    expect(duplicate).toBeUndefined()
    expect(later).toBeUndefined()
  })

  test("does not toast for transient network failures", () => {
    const surfaced = new Set<string>()
    const toast = webSearchRecoveryToast(part({ kind: "network", source: "anonymous" }), { surfaced })

    expect(toast).toBeUndefined()
  })

  test("does not point env invalid keys at saved-key settings recovery", () => {
    const surfaced = new Set<string>()
    const toast = webSearchRecoveryToast(part({ callID: "call-env", kind: "invalid_key", source: "env" }), {
      surfaced,
    })

    expect(toast).toBeUndefined()
    expect(surfaced.has("call-env")).toBe(false)
  })
})
