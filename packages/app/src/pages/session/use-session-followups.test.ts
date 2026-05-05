import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type {
  followupDraftForDirectory as DraftForDirectory,
  followupPreviewText as PreviewText,
  shouldAutoSendFollowup as ShouldAutoSend,
} from "./use-session-followups"

let followupPreviewText: typeof PreviewText
let shouldAutoSendFollowup: typeof ShouldAutoSend
let followupDraftForDirectory: typeof DraftForDirectory

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
  followupDraftForDirectory = mod.followupDraftForDirectory
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
      actionReady: true,
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
    expect(shouldAutoSendFollowup({ ...base, actionReady: false })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, busy: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, failed: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, paused: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, childSession: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, blocked: true })).toBe(false)
    expect(shouldAutoSendFollowup({ ...base, followupBusy: true })).toBe(false)
  })

  // Auto-heal flow: while the recovery clock is armed (running question
  // part with no UI dock) the session is still busy AND blocked is false
  // (the dock never surfaced). Auto-send must stay off. Once the clock
  // halts the session, busy flips false on the next status sync and the
  // queued followup must be eligible for auto-send. This locks step 6 of
  // the v6 spec merge gate.
  test("queued followup auto-sends after halt-induced idle (auto-heal flow)", () => {
    const recovering = {
      hasSession: true,
      hasItem: true,
      actionReady: true,
      busy: true,
      failed: false,
      paused: false,
      childSession: false,
      blocked: false,
      followupBusy: false,
    }
    expect(shouldAutoSendFollowup(recovering)).toBe(false)

    const afterHalt = { ...recovering, busy: false }
    expect(shouldAutoSendFollowup(afterHalt)).toBe(true)
  })

  test("queued followup waits for current directory data after a directory switch", () => {
    const switchingDirectory = {
      hasSession: true,
      hasItem: true,
      actionReady: false,
      busy: false,
      failed: false,
      paused: false,
      childSession: false,
      blocked: false,
      followupBusy: false,
    }

    expect(shouldAutoSendFollowup(switchingDirectory)).toBe(false)
    expect(shouldAutoSendFollowup({ ...switchingDirectory, actionReady: true })).toBe(true)
  })

  test("rebases a queued followup to the current execution directory before send", () => {
    const prompt = [
      { type: "text", content: "check @src/app.ts", start: 0, end: 17 },
      { type: "file", content: "@src/app.ts", start: 18, end: 29, path: "src/app.ts" },
    ] as FollowupDraft["prompt"]
    const context = [
      {
        key: "comment:1",
        type: "file",
        path: "src/app.ts",
        comment: "review this",
        commentID: "cmt_1",
        commentOrigin: "review",
      },
    ] as FollowupDraft["context"]
    const item = {
      id: "msg_1",
      ...draft({
        prompt,
        context,
      }),
    }

    const next = followupDraftForDirectory(item, "/repo")
    expect(next).toBe(item)

    const rebased = followupDraftForDirectory(item, "/repo-root")
    expect(rebased).not.toBe(item)
    expect(rebased.sessionDirectory).toBe("/repo-root")
    expect(rebased.sessionID).toBe(item.sessionID)
    expect(rebased.prompt).toBe(item.prompt)
    expect(rebased.context).toBe(item.context)
    expect(rebased.prompt[1]).toMatchObject({ type: "file", path: "src/app.ts" })
    expect(rebased.context[0]).toMatchObject({
      path: "src/app.ts",
      commentID: "cmt_1",
      commentOrigin: "review",
    })
  })
})
