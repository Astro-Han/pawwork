import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  currentDirectoryProviderUsable,
  currentSessionActionReady,
  currentSessionCacheReady,
  currentSessionSubmitReady,
  currentWorkspaceSubmitReady,
  readTimelineMessages,
  readTimelineMessagesFromCache,
  sessionStatusKnown,
  timelineDataIdentity,
  timelineModelSyncKey,
} from "./use-session-timeline-data"
import { sessionScopeKey } from "./session-scope"

const userMessage = (id: string, sessionID = "ses_target"): Message =>
  ({
    id,
    role: "user",
    sessionID,
    time: { created: 1 },
  }) as Message

const sessionScope = (sessionID = "ses_target", serverKey = "sidecar") => ({ serverKey, sessionID })
const messages120 = Array.from({ length: 120 }, (_, index) => userMessage(`msg_${index}`))

describe("readTimelineMessages", () => {
  test("keeps last-good messages for the same session when the current store briefly loses its cache", () => {
    const loaded = [userMessage("msg_1"), userMessage("msg_2")]
    const scope = sessionScope()
    const ready = readTimelineMessages({
      scope,
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      scope,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toBe(loaded)
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("keeps a long session window during a same-session cache miss", () => {
    const loaded = Array.from({ length: 80 }, (_, index) => userMessage(`msg_${index}`))
    const scope = sessionScope()
    const ready = readTimelineMessages({
      scope,
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      scope,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toHaveLength(80)
    expect(missing.messages).toBe(loaded)
  })

  test("does not reuse last-good messages after switching to another session", () => {
    const loaded = [userMessage("msg_1", "ses_source")]
    const sourceScope = sessionScope("ses_source")
    const targetScope = sessionScope("ses_target")
    const ready = readTimelineMessages({
      scope: sourceScope,
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      scope: targetScope,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toEqual([])
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("does not reuse last-good messages after the same session id gets a different identity scope", () => {
    const loaded = [userMessage("msg_1")]
    const localScope = sessionScope("ses_target", "server-a")
    const remoteScope = sessionScope("ses_target", "server-b")
    const ready = readTimelineMessages({
      scope: localScope,
      dataIdentity: timelineDataIdentity({ scope: localScope, created: 1 }),
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      scope: remoteScope,
      dataIdentity: timelineDataIdentity({ scope: remoteScope, created: 1 }),
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toEqual([])
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("keeps last-good messages when the same session cache misses before session info reloads", () => {
    const loaded = [userMessage("msg_1"), userMessage("msg_2")]
    const scope = sessionScope()
    const ready = readTimelineMessages({
      scope,
      dataIdentity: timelineDataIdentity({ scope, created: 123 }),
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      scope,
      dataIdentity: undefined,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toBe(loaded)
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("clears last-good messages when there is no active session", () => {
    const loaded = [userMessage("msg_1", "ses_source")]
    const ready = readTimelineMessages({
      scope: sessionScope("ses_source"),
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      scope: undefined,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toEqual([])
    expect(missing.lastGood).toBeUndefined()
  })

  test("treats an empty raw message array as authoritative loaded data", () => {
    const scope = sessionScope()
    const ready = readTimelineMessages({
      scope,
      raw: [userMessage("msg_1"), userMessage("msg_2")],
      lastGood: undefined,
    })

    const empty = readTimelineMessages({
      scope,
      raw: [],
      lastGood: ready.lastGood,
    })

    expect(empty.messages).toEqual([])
    expect(empty.lastGood?.messages).toEqual([])
  })

  test("last-good timeline cache does not cross server scopes with same session id", () => {
    const localScope = sessionScope("ses_same", "sidecar")
    const remoteScope = sessionScope("ses_same", "https://remote.example")

    const first = readTimelineMessages({
      scope: localScope,
      dataIdentity: timelineDataIdentity({ scope: localScope, created: 1 }),
      raw: messages120,
      lastGood: undefined,
    })

    const second = readTimelineMessages({
      scope: remoteScope,
      dataIdentity: timelineDataIdentity({ scope: remoteScope, created: 1 }),
      raw: undefined,
      lastGood: first.lastGood,
    })

    expect(sessionScopeKey(localScope)).not.toBe(sessionScopeKey(remoteScope))
    expect(second.messages).toEqual([])
  })

  test("last-good timeline cache keeps long same-scoped timeline during transient cache miss", () => {
    const scope = sessionScope("ses_long")
    const first = readTimelineMessages({
      scope,
      dataIdentity: timelineDataIdentity({ scope, created: 1 }),
      raw: messages120,
      lastGood: undefined,
    })

    const second = readTimelineMessages({
      scope,
      dataIdentity: timelineDataIdentity({ scope, created: 1 }),
      raw: undefined,
      lastGood: first.lastGood,
    })

    expect(second.messages.length).toBe(120)
  })
})

describe("readTimelineMessagesFromCache", () => {
  test("keeps messages when directory switch makes session info and message cache briefly unavailable", () => {
    const loaded = [userMessage("msg_1"), userMessage("msg_2")]
    const scope = sessionScope()
    const ready = readTimelineMessagesFromCache({
      scope,
      sessionCreated: 123,
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessagesFromCache({
      scope,
      sessionCreated: undefined,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toBe(loaded)
    expect(missing.lastGood).toBe(ready.lastGood)
  })
})

describe("timelineModelSyncKey", () => {
  test("changes when the directory changes even if the last user message is the same", () => {
    expect(timelineModelSyncKey({ directory: "/worktree", messageID: "msg", localReady: true })).not.toBe(
      timelineModelSyncKey({ directory: "/root", messageID: "msg", localReady: true }),
    )
  })

  test("changes when the directory-local model selection store becomes ready", () => {
    expect(timelineModelSyncKey({ directory: "/repo", messageID: "msg", localReady: false })).not.toBe(
      timelineModelSyncKey({ directory: "/repo", messageID: "msg", localReady: true }),
    )
  })
})

describe("currentSessionCacheReady", () => {
  test("waits for current session info and message cache before actions are ready", () => {
    expect(
      currentSessionCacheReady({
        sessionID: "ses",
        sessionInfo: undefined,
        rawMessages: undefined,
      }),
    ).toBe(false)

    expect(
      currentSessionCacheReady({
        sessionID: "ses",
        sessionInfo: { id: "ses" },
        rawMessages: [],
      }),
    ).toBe(true)
  })
})

describe("currentSessionActionReady", () => {
  test("waits for the directory status list as well as cache hydration", () => {
    expect(
      currentSessionActionReady({
        sessionID: "ses",
        sessionInfo: { id: "ses" },
        rawMessages: [],
        statusReady: false,
      }),
    ).toBe(false)

    expect(
      currentSessionActionReady({
        sessionID: "ses",
        sessionInfo: { id: "ses" },
        rawMessages: [],
        statusReady: true,
      }),
    ).toBe(true)
  })

  test("does not wait for model selection or provider hydration", () => {
    expect(
      currentSessionActionReady({
        sessionID: "ses",
        sessionInfo: { id: "ses" },
        rawMessages: [],
        statusReady: true,
      }),
    ).toBe(true)
  })

  test("treats a loaded empty status list as idle for an otherwise hydrated session", () => {
    expect(
      currentSessionActionReady({
        sessionID: "ses",
        sessionInfo: { id: "ses" },
        rawMessages: [],
        statusReady: true,
      }),
    ).toBe(true)
  })
})

describe("currentSessionSubmitReady", () => {
  test("waits for directory-local model selection and provider hydration", () => {
    const ready = {
      sessionID: "ses",
      sessionInfo: { id: "ses" },
      rawMessages: [],
      statusReady: true,
    }

    expect(currentSessionSubmitReady({ ...ready, localReady: false, providerUsable: true })).toBe(false)
    expect(currentSessionSubmitReady({ ...ready, localReady: true, providerUsable: false })).toBe(false)
    expect(currentSessionSubmitReady({ ...ready, localReady: true, providerUsable: true })).toBe(true)
  })
})

describe("currentWorkspaceSubmitReady", () => {
  test("waits for model selection and provider readiness when there is no session", () => {
    expect(currentWorkspaceSubmitReady({ localReady: false, providerUsable: true })).toBe(false)
    expect(currentWorkspaceSubmitReady({ localReady: true, providerUsable: false })).toBe(false)
    expect(currentWorkspaceSubmitReady({ localReady: true, providerUsable: true })).toBe(true)
  })
})

describe("currentDirectoryProviderUsable", () => {
  test("allows seeded provider data before the directory refresh finishes", () => {
    expect(currentDirectoryProviderUsable({ providerReady: false, providerCount: 0 })).toBe(false)
    expect(currentDirectoryProviderUsable({ providerReady: false, providerCount: 1 })).toBe(true)
    expect(currentDirectoryProviderUsable({ providerReady: true, providerCount: 0 })).toBe(true)
  })
})

describe("sessionStatusKnown", () => {
  test("does not trust stale idle status while the status list is refreshing", () => {
    expect(sessionStatusKnown({ statusState: "loading", status: { type: "idle" } })).toBe(false)
  })

  test("trusts active statuses before the status list finishes refreshing", () => {
    expect(sessionStatusKnown({ statusState: "loading", status: { type: "busy" } })).toBe(true)
    expect(
      sessionStatusKnown({
        statusState: "loading",
        status: {
          type: "retry",
          attempt: 1,
          message: "retrying",
          next: Date.now(),
        },
      }),
    ).toBe(true)
  })

  test("allows degraded actions after status list hydration fails", () => {
    expect(sessionStatusKnown({ statusState: "error", status: undefined })).toBe(true)
    expect(
      currentSessionSubmitReady({
        sessionID: "ses",
        sessionInfo: { id: "ses" },
        rawMessages: [],
        statusReady: sessionStatusKnown({ statusState: "error", status: undefined }),
        localReady: true,
        providerUsable: true,
      }),
    ).toBe(true)
  })
})
