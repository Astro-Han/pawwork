import { describe, expect, test } from "bun:test"
import {
  createBrowserBridgeHost,
  pickAutomationWindow,
  type AutomationWindowCandidate,
} from "./automation-resolver"

describe("pickAutomationWindow", () => {
  test("prefers the window showing the session", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_a",
      candidates: [
        { windowID: 1, sessionID: "ses_other" },
        { windowID: 2, sessionID: "ses_a" },
      ],
      focusedWindowID: 1,
    })
    expect(pick).toEqual({ windowID: 2 })
  })

  test("session match wins even after the user focuses another window", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_a",
      candidates: [
        { windowID: 1, sessionID: "ses_a" },
        { windowID: 2, sessionID: "ses_b" },
      ],
      focusedWindowID: 2,
    })
    expect(pick).toEqual({ windowID: 1 })
  })

  test("same session visible in two windows resolves to the focused one", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_a",
      candidates: [
        { windowID: 1, sessionID: "ses_a" },
        { windowID: 2, sessionID: "ses_a" },
      ],
      focusedWindowID: 2,
    })
    expect(pick).toEqual({ windowID: 2 })
  })

  test("a single window serves sessions it is not showing (background automation)", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_background",
      candidates: [{ windowID: 7, sessionID: "ses_visible" }],
      focusedWindowID: null,
    })
    expect(pick).toEqual({ windowID: 7 })
  })

  test("multiple windows without a session match fall back to the focused window", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_background",
      candidates: [
        { windowID: 1, sessionID: "ses_x" },
        { windowID: 2, sessionID: "ses_y" },
      ],
      focusedWindowID: 2,
    })
    expect(pick).toEqual({ windowID: 2 })
  })

  test("multiple unfocused windows without a session match are ambiguous", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_background",
      candidates: [
        { windowID: 1, sessionID: "ses_x" },
        { windowID: 2, sessionID: null },
      ],
      focusedWindowID: null,
    })
    expect(pick).toEqual({ error: "window-ambiguous" })
  })

  test("no windows is a typed no-window error", () => {
    const pick = pickAutomationWindow({
      sessionID: "ses_a",
      candidates: [],
      focusedWindowID: null,
    })
    expect(pick).toEqual({ error: "no-window" })
  })
})

function makeHost(overrides?: { windows?: () => AutomationWindowCandidate[]; windowUrl?: (id: number) => string | null }) {
  const calls = { attach: [] as number[], detach: [] as number[], url: [] as number[] }
  const host = createBrowserBridgeHost({
    windows: overrides?.windows ?? (() => [{ windowID: 1, sessionID: "ses_a" }]),
    focusedWindowID: () => null,
    attachWindow: async (windowID) => {
      calls.attach.push(windowID)
      return { cdpEndpoint: `ws://127.0.0.1:9000/secret-${windowID}` }
    },
    detachWindow: async (windowID) => {
      calls.detach.push(windowID)
    },
    windowUrl: (windowID) => {
      calls.url.push(windowID)
      return overrides?.windowUrl ? overrides.windowUrl(windowID) : null
    },
  })
  return { host, calls }
}

describe("createBrowserBridgeHost", () => {
  test("resolveEndpoint attaches the picked window and releaseSession detaches it", async () => {
    const { host, calls } = makeHost()
    const endpoint = await host.resolveEndpoint({ sessionID: "ses_a" })
    expect(endpoint.cdpEndpoint).toContain("ws://127.0.0.1")
    expect(calls.attach).toEqual([1])

    await host.releaseSession({ sessionID: "ses_a" })
    expect(calls.detach).toEqual([1])
  })

  test("releaseSession for a session that never attached is a no-op", async () => {
    const { host, calls } = makeHost()
    await host.releaseSession({ sessionID: "ses_unknown" })
    expect(calls.detach).toEqual([])
  })

  test("a typed picking error surfaces with its code and attaches nothing", async () => {
    const { host, calls } = makeHost({ windows: () => [] })
    await expect(host.resolveEndpoint({ sessionID: "ses_a" })).rejects.toMatchObject({ code: "no-window" })
    expect(calls.attach).toEqual([])
  })

  test("probeWindow reads the picked window's view URL without attaching anything", async () => {
    const { host, calls } = makeHost({ windowUrl: () => "https://example.com/open" })
    const probe = await host.probeWindow({ sessionID: "ses_a" })
    expect(probe).toEqual({ windowID: 1, url: "https://example.com/open" })
    expect(calls.url).toEqual([1])
    expect(calls.attach).toEqual([])
  })

  test("probeWindow is null when no window can serve the session", async () => {
    const { host, calls } = makeHost({ windows: () => [] })
    expect(await host.probeWindow({ sessionID: "ses_a" })).toBeNull()
    expect(calls.attach).toEqual([])
    expect(calls.url).toEqual([])
  })

  test("probeWindow prefers the window the session is already attached to over the pick", async () => {
    // Two windows, neither showing the session: the pick would follow focus,
    // but ses_a already attached window 1 — the probe must keep reporting it.
    const windows = () => [
      { windowID: 1, sessionID: null },
      { windowID: 2, sessionID: null },
    ]
    const { host } = makeHost({
      windows,
      windowUrl: (id) => `https://example.com/win-${id}`,
    })
    await host.resolveEndpoint({ sessionID: "ses_a", windowID: 1 })
    const probe = await host.probeWindow({ sessionID: "ses_a" })
    expect(probe).toEqual({ windowID: 1, url: "https://example.com/win-1" })
  })

  test("resolveEndpoint honors the probe's window lease over the current focus", async () => {
    const windows = () => [
      { windowID: 1, sessionID: null },
      { windowID: 2, sessionID: null },
    ]
    const focused = { id: 2 } // focus moved to window 2 after the probe picked 1
    const calls = { attach: [] as number[] }
    const host = createBrowserBridgeHost({
      windows,
      focusedWindowID: () => focused.id,
      attachWindow: async (windowID) => {
        calls.attach.push(windowID)
        return { cdpEndpoint: `ws://127.0.0.1:9000/secret-${windowID}` }
      },
      detachWindow: async () => {},
      windowUrl: () => null,
    })
    await host.resolveEndpoint({ sessionID: "ses_a", windowID: 1 })
    expect(calls.attach).toEqual([1])
  })

  test("resolveEndpoint fails as no-window when the leased window closed", async () => {
    const { host, calls } = makeHost()
    await expect(host.resolveEndpoint({ sessionID: "ses_a", windowID: 99 })).rejects.toMatchObject({
      code: "no-window",
    })
    expect(calls.attach).toEqual([])
  })

  test("a second session taking over the same window invalidates the first session's claim", async () => {
    const { host, calls } = makeHost()
    await host.resolveEndpoint({ sessionID: "ses_a" })
    await host.resolveEndpoint({ sessionID: "ses_b" })

    // ses_b released last: detaches the shared window once.
    await host.releaseSession({ sessionID: "ses_b" })
    expect(calls.detach).toEqual([1])

    // ses_a's stale claim was dropped with it; releasing again must not
    // detach a bridge it no longer owns.
    await host.releaseSession({ sessionID: "ses_a" })
    expect(calls.detach).toEqual([1])
  })
})
