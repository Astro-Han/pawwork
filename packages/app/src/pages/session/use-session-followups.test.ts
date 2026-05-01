import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type { followupPreviewText as PreviewText, shouldAutoSendFollowup as ShouldAutoSend } from "./use-session-followups"

let followupPreviewText: typeof PreviewText
let shouldAutoSendFollowup: typeof ShouldAutoSend

const draft = (input: Pick<FollowupDraft, "prompt" | "context">): FollowupDraft => ({
  sessionID: "ses_1",
  sessionDirectory: "/repo",
  agent: "agent",
  model: { providerID: "provider", modelID: "model" },
  ...input,
})

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/util/encode", () => ({
    base64Decode: (value: string) => value,
    base64Encode: (value: string) => value,
    checksum: (value: string) => String(value.length),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./use-session-followups")
  followupPreviewText = mod.followupPreviewText
  shouldAutoSendFollowup = mod.shouldAutoSendFollowup
})

describe("session followups", () => {
  test("uses first non-empty text line as dock preview", () => {
    expect(
      followupPreviewText({
        attachmentLabel: "Attachment",
        item: draft({
          prompt: [{ type: "text", content: "\n  run tests\nmore", start: 0, end: 17 }],
          context: [],
        }),
      }),
    ).toBe("run tests")
  })

  test("falls back to attachment label when prompt has no visible text", () => {
    expect(
      followupPreviewText({
        attachmentLabel: "Attachment",
        item: draft({
          prompt: [],
          context: [],
        }),
      }),
    ).toBe("[Attachment]")
  })

  test("auto-send is blocked by busy, failure, pause, child session, permission block, or active mutation", () => {
    const base = {
      hasSession: true,
      hasItem: true,
      busy: false,
      failed: false,
      paused: false,
      childSession: false,
      blocked: false,
      followupBusy: false,
    }

    expect(shouldAutoSendFollowup(base)).toBe(true)
    expect(shouldAutoSendFollowup({ ...base, hasSession: false })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, hasItem: false })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, busy: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, failed: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, paused: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, childSession: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, blocked: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, followupBusy: true })).toBe(false)
  })
})
