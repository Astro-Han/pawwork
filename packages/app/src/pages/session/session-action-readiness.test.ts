import { beforeAll, describe, expect, mock, test } from "bun:test"
import {
  canSendFollowupDraft,
  canSubmitPrompt,
  currentDirectoryProviderUsable,
  currentSessionActionReady,
  currentSessionSubmitReady,
  sessionStatusKnown,
} from "./session-action-readiness"
import type { followupCommandText as FollowupCommandText, FollowupDraft } from "@/components/prompt-input/submit"

let followupCommandText: typeof FollowupCommandText

const slashDraft = { text: "/release now" }
const normalDraft = { text: "continue" }
const leadingWhitespaceSlashDraft = { text: " /release now" }

const queuedDraft = (input: { prompt: FollowupDraft["prompt"] }): FollowupDraft => ({
  sessionID: "ses_1",
  sessionDirectory: "/repo",
  prompt: input.prompt,
  context: [],
  agent: "agent",
  model: { providerID: "provider", modelID: "model" },
})

describe("session action readiness", () => {
  beforeAll(async () => {
    mock.module("@solidjs/router", () => ({
      useNavigate: () => () => undefined,
      useParams: () => ({}),
    }))

    const mod = await import("@/components/prompt-input/submit")
    followupCommandText = mod.followupCommandText
  })

  test("direct slash submit waits for command hydration", () => {
    expect(canSubmitPrompt({ mode: "normal", text: "/release", submitReady: true, commandsReady: false })).toBe(false)
    expect(canSubmitPrompt({ mode: "normal", text: " /release", submitReady: true, commandsReady: false })).toBe(true)
    expect(canSubmitPrompt({ mode: "normal", text: "normal prompt", submitReady: true, commandsReady: false })).toBe(
      true,
    )
    expect(canSubmitPrompt({ mode: "normal", text: "/release", submitReady: true, commandsReady: true })).toBe(true)
  })

  test("shell submit does not wait for command hydration", () => {
    expect(canSubmitPrompt({ mode: "shell", text: "/bin/ls", submitReady: true, commandsReady: false })).toBe(true)
    expect(canSubmitPrompt({ mode: "shell", text: "/release", submitReady: false, commandsReady: true })).toBe(false)
  })

  test("queued slash follow-up waits for command hydration", () => {
    expect(canSendFollowupDraft({ draft: slashDraft, submitReady: true, commandsReady: false })).toBe(false)
    expect(canSendFollowupDraft({ draft: slashDraft, submitReady: true, commandsReady: true })).toBe(true)
    expect(canSendFollowupDraft({ draft: normalDraft, submitReady: true, commandsReady: false })).toBe(true)
    expect(canSendFollowupDraft({ draft: leadingWhitespaceSlashDraft, submitReady: true, commandsReady: false })).toBe(
      true,
    )
  })

  test("queued slash follow-up uses the same command text as sendFollowupDraft", () => {
    const draftWithLeadingImage = queuedDraft({
      prompt: [
        { type: "image", id: "img_1", filename: "screen.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
        { type: "text", content: "/release now", start: 0, end: 12 },
      ],
    })

    expect(followupCommandText(draftWithLeadingImage)).toBe("/release now")
    expect(
      canSendFollowupDraft({
        draft: { text: followupCommandText(draftWithLeadingImage) },
        submitReady: true,
        commandsReady: false,
      }),
    ).toBe(false)
  })

  test("session actions wait for cache and status", () => {
    expect(currentSessionActionReady({ sessionID: "ses_1", sessionInfo: {}, rawMessages: [], statusReady: true })).toBe(
      true,
    )
    expect(
      currentSessionActionReady({ sessionID: "ses_1", sessionInfo: undefined, rawMessages: [], statusReady: true }),
    ).toBe(false)
  })

  test("submit waits for local model and provider usability", () => {
    expect(
      currentSessionSubmitReady({
        sessionID: "ses_1",
        sessionInfo: {},
        rawMessages: [],
        statusReady: true,
        localReady: true,
        providerUsable: true,
      }),
    ).toBe(true)
    expect(
      currentSessionSubmitReady({
        sessionID: "ses_1",
        sessionInfo: {},
        rawMessages: [],
        statusReady: true,
        localReady: false,
        providerUsable: true,
      }),
    ).toBe(false)
  })

  test("seeded providers are usable before refresh completes", () => {
    expect(currentDirectoryProviderUsable({ providerReady: false, providerCount: 0 })).toBe(false)
    expect(currentDirectoryProviderUsable({ providerReady: false, providerCount: 1 })).toBe(true)
  })

  test("busy or retry means status is known during loading", () => {
    expect(sessionStatusKnown({ statusState: "loading", status: { type: "busy" } })).toBe(true)
    expect(sessionStatusKnown({ statusState: "loading", status: { type: "idle" } })).toBe(false)
    expect(sessionStatusKnown({ statusState: "ready", status: undefined })).toBe(true)
  })
})
