import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type {
  canSendFollowupItem as CanSendFollowupItem,
  createSessionFollowups as CreateSessionFollowups,
  followupDraftMatchesScope as FollowupDraftMatchesScope,
  followupDraftForDirectory as DraftForDirectory,
  followupPreviewText as PreviewText,
  followupStoreKey as FollowupStoreKey,
  scopedFollowupDraft as ScopedFollowupDraft,
  shouldAutoSendFollowup as ShouldAutoSend,
} from "./use-session-followups"

let followupPreviewText: typeof PreviewText
let shouldAutoSendFollowup: typeof ShouldAutoSend
let followupDraftForDirectory: typeof DraftForDirectory
let canSendFollowupItem: typeof CanSendFollowupItem
let createSessionFollowups: typeof CreateSessionFollowups
let followupStoreKey: typeof FollowupStoreKey
let scopedFollowupDraft: typeof ScopedFollowupDraft
let followupDraftMatchesScope: typeof FollowupDraftMatchesScope
const sendFollowupCalls: unknown[] = []

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
  mock.module("@/utils/persist", () => ({
    Persist: {
      global: () => ({}),
    },
    persisted: (_target: unknown, store: unknown) => store,
  }))
  mock.module("@/utils/id", () => ({
    Identifier: {
      ascending: (prefix: string) => `${prefix}_queued`,
    },
  }))
  mock.module("@/components/prompt-input/submit", () => ({
    followupCommandText: (item: FollowupDraft) =>
      item.outgoingTextOverride ?? item.prompt.map((part) => ("content" in part ? part.content : "")).join(""),
    sendFollowupDraft: async (input: unknown) => {
      sendFollowupCalls.push(input)
      return true
    },
  }))

  const mod = await import("./use-session-followups")
  followupPreviewText = mod.followupPreviewText
  shouldAutoSendFollowup = mod.shouldAutoSendFollowup
  followupDraftForDirectory = mod.followupDraftForDirectory
  canSendFollowupItem = mod.canSendFollowupItem
  createSessionFollowups = mod.createSessionFollowups
  followupStoreKey = mod.followupStoreKey
  scopedFollowupDraft = mod.scopedFollowupDraft
  followupDraftMatchesScope = mod.followupDraftMatchesScope
})

describe("session followups", () => {
  beforeEach(() => {
    sendFollowupCalls.length = 0
    localStorage.clear()
  })

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

  test("followup store key includes server and session", () => {
    expect(followupStoreKey({ serverKey: "sidecar", sessionID: "ses_same" })).not.toBe(
      followupStoreKey({ serverKey: "remote", sessionID: "ses_same" }),
    )
  })

  test("unscoped v2 followup item is rejected", () => {
    const item = {
      id: "msg_1",
      sessionID: "ses_same",
      sessionDirectory: "/repo",
      prompt: [{ type: "text" as const, content: "next", start: 0, end: 4 }],
      context: [],
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
      locale: "en-US",
    }

    expect(followupDraftMatchesScope(item as { sourceScope?: never }, { serverKey: "sidecar", sessionID: "ses_same" })).toBe(
      false,
    )
  })

  test("scoped followup validates exact source scope", () => {
    const item = scopedFollowupDraft(
      {
        id: "msg_1",
        sessionID: "ses_same",
        sessionDirectory: "/repo",
        prompt: [{ type: "text" as const, content: "next", start: 0, end: 4 }],
        context: [],
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude" },
        locale: "en-US",
      },
      { serverKey: "sidecar", sessionID: "ses_same" },
    )

    expect(followupDraftMatchesScope(item, { serverKey: "sidecar", sessionID: "ses_same" })).toBe(true)
    expect(followupDraftMatchesScope(item, { serverKey: "remote", sessionID: "ses_same" })).toBe(false)
  })

  test("queued slash follow-up with leading image waits for command hydration", () => {
    const item = draft({
      prompt: [
        { type: "image", id: "img_1", filename: "screen.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
        { type: "text", content: "/release now", start: 0, end: 12 },
      ],
      context: [],
    })

    expect(canSendFollowupItem({ item, actionReady: true, commandsReady: false })).toBe(false)
    expect(canSendFollowupItem({ item, actionReady: true, commandsReady: true })).toBe(true)
  })

  test("normal queued follow-up with leading image can send while commands hydrate", () => {
    const item = draft({
      prompt: [
        { type: "image", id: "img_1", filename: "screen.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
        { type: "text", content: "continue", start: 0, end: 8 },
      ],
      context: [],
    })

    expect(canSendFollowupItem({ item, actionReady: true, commandsReady: false })).toBe(true)
  })

  test("leading-whitespace slash follow-up can send while commands hydrate", () => {
    const item = draft({
      prompt: [{ type: "text", content: " /release now", start: 0, end: 13 }],
      context: [],
    })

    expect(canSendFollowupItem({ item, actionReady: true, commandsReady: false })).toBe(true)
  })

  test("queued send call-site waits for command hydration when slash draft has a leading image", async () => {
    const [syncData, setSyncData] = createStore({ command: [{ name: "release" }], command_ready: false })
    let followups!: ReturnType<typeof createSessionFollowups>
    let disposeRoot!: VoidFunction

    disposeRoot = createRoot((dispose) => {
      const queryClient = new QueryClient()
      QueryClientProvider({
        client: queryClient,
        children: () => {
          followups = createSessionFollowups({
            directory: () => "/repo",
            client: () => ({}) as never,
            sessionID: () => "ses_send",
            sessionScope: () => ({ serverKey: "sidecar", sessionID: "ses_send" }),
            actionReady: () => true,
            isChildSession: () => false,
            busy: () => false,
            blocked: () => false,
            settings: {
              general: {
                followup: () => "queue",
              },
            } as never,
            sync: {
              data: syncData,
              session: { get: () => ({ id: "ses_send" }) },
            } as never,
            globalSync: {} as never,
            fail: () => undefined,
            resumeScroll: () => undefined,
            attachmentLabel: () => "Attachment",
          })
          return null
        },
      } as never)
      return dispose
    })

    try {
      followups.queueFollowup({
        sessionID: "ses_send",
        sessionDirectory: "/repo",
        prompt: [
          {
            type: "image",
            id: "img_1",
            filename: "screen.png",
            mime: "image/png",
            dataUrl: "data:image/png;base64,AA==",
          },
          { type: "text", content: "/release now", start: 0, end: 12 },
        ],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      })
      await followups.sendFollowup("message_queued", { manual: true })
      expect(sendFollowupCalls).toHaveLength(0)

      setSyncData("command_ready", true)
      await followups.sendFollowup("message_queued", { manual: true })
      expect(sendFollowupCalls).toHaveLength(1)
    } finally {
      disposeRoot()
    }
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
    const item = scopedFollowupDraft(
      {
        id: "msg_1",
        ...draft({
          prompt,
          context,
        }),
      },
      { serverKey: "sidecar", sessionID: "ses_1" },
    )

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
