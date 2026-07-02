import { describe, expect, test } from "bun:test"
import {
  isSurfaceRoutePath,
  parseSessionRoutePath,
  readSurfaceRouteState,
  resolveSurfaceClose,
  surfaceEntryState,
  surfaceRouteName,
} from "./surface-routes"

describe("surfaceRouteName", () => {
  test("maps the three surface paths and nothing else", () => {
    expect(surfaceRouteName("/settings")).toBe("settings")
    expect(surfaceRouteName("/automations")).toBe("automations")
    expect(surfaceRouteName("/skills")).toBe("skills")
    expect(surfaceRouteName("/settings/general")).toBeUndefined()
    expect(surfaceRouteName("/abc/session")).toBeUndefined()
    expect(isSurfaceRoutePath("/skills")).toBe(true)
    expect(isSurfaceRoutePath("/")).toBe(false)
  })
})

describe("surfaceEntryState", () => {
  test("pushes the current location onto the origin stack", () => {
    const state = surfaceEntryState({
      location: { pathname: "/dir123/session/ses_1", search: "?x=1" },
      automationID: "auto_1",
    })
    expect(state.origins).toEqual([{ pathname: "/dir123/session/ses_1", search: "?x=1", automationID: undefined }])
    expect(state.automationID).toBe("auto_1")
  })

  test("a pushed surface hop keeps its own deep-entry intent", () => {
    const automationsEntry = surfaceEntryState({
      location: { pathname: "/dir123/session/ses_1", search: "" },
      automationID: "auto_1",
    })
    const settingsEntry = surfaceEntryState({
      location: { pathname: "/automations", search: "", state: automationsEntry },
    })
    expect(settingsEntry.origins?.map((origin) => origin.pathname)).toEqual(["/dir123/session/ses_1", "/automations"])
    expect(settingsEntry.origins?.at(-1)?.automationID).toBe("auto_1")
    expect(settingsEntry.automationID).toBeUndefined()
  })
})

describe("readSurfaceRouteState", () => {
  test("rejects malformed input", () => {
    expect(readSurfaceRouteState(undefined)).toBeUndefined()
    expect(readSurfaceRouteState("nope")).toBeUndefined()
    expect(readSurfaceRouteState({})).toBeUndefined()
    expect(readSurfaceRouteState({ origins: "nope" })).toBeUndefined()
    expect(readSurfaceRouteState({ origins: [{ pathname: "not-absolute" }] })).toBeUndefined()
    expect(readSurfaceRouteState({ automationID: 42 })).toBeUndefined()
  })

  test("rejects pathnames and searches that would escape the app", () => {
    expect(readSurfaceRouteState({ origins: [{ pathname: "//example.com", search: "" }] })).toBeUndefined()
    expect(readSurfaceRouteState({ origins: [{ pathname: "/\\example.com", search: "" }] })).toBeUndefined()
    expect(readSurfaceRouteState({ origins: [{ pathname: "/dir\\evil", search: "" }] })).toBeUndefined()
    expect(readSurfaceRouteState({ origins: [{ pathname: "/dir\nevil", search: "" }] })).toBeUndefined()
    // A non-"?" search would splice into the path ("/" + "/evil.com" → "//evil.com").
    expect(readSurfaceRouteState({ origins: [{ pathname: "/", search: "/evil.com" }] })?.origins).toEqual([
      { pathname: "/", search: "", automationID: undefined },
    ])
  })

  test("drops malformed stack entries without poisoning the rest", () => {
    const state = readSurfaceRouteState({
      origins: [{ pathname: "/dir/session", search: "" }, { pathname: "not-absolute" }, "nope"],
    })
    expect(state?.origins).toEqual([{ pathname: "/dir/session", search: "", automationID: undefined }])
  })

  test("caps pathological chain depth at the limit", () => {
    let state: unknown = surfaceEntryState({ location: { pathname: "/dir/session", search: "" } })
    for (let hop = 0; hop < 20; hop += 1) {
      state = surfaceEntryState({ location: { pathname: "/settings", search: "", state } })
    }
    expect(readSurfaceRouteState(state)?.origins).toHaveLength(8)
  })
})

describe("parseSessionRoutePath", () => {
  test("parses session routes with and without an id", () => {
    expect(parseSessionRoutePath("/dir123/session/ses_1")).toEqual({ slug: "dir123", sessionID: "ses_1" })
    expect(parseSessionRoutePath("/dir123/session")).toEqual({ slug: "dir123", sessionID: undefined })
    expect(parseSessionRoutePath("/settings")).toBeUndefined()
    expect(parseSessionRoutePath("/")).toBeUndefined()
  })
})

describe("resolveSurfaceClose", () => {
  const sessionEntry = surfaceEntryState({
    location: { pathname: "/dir123/session/ses_1", search: "" },
  })

  test("returns to a validated main-area origin", () => {
    const close = resolveSurfaceClose({ state: sessionEntry, validateOrigin: () => true, fallback: "/" })
    expect(close.href).toBe("/dir123/session/ses_1")
    expect(close.state).toBeUndefined()
  })

  test("falls back when the origin is stale", () => {
    const close = resolveSurfaceClose({ state: sessionEntry, validateOrigin: () => false, fallback: "/dir123/session" })
    expect(close.href).toBe("/dir123/session")
    expect(close.state).toBeUndefined()
  })

  test("falls back when there is no origin (restart, direct landing)", () => {
    const close = resolveSurfaceClose({ state: undefined, validateOrigin: () => true, fallback: "/" })
    expect(close.href).toBe("/")
  })

  test("falls back instead of navigating to an app-escaping pathname", () => {
    const close = resolveSurfaceClose({
      state: { origins: [{ pathname: "//example.com", search: "" }] },
      validateOrigin: () => true,
      fallback: "/safe",
    })
    expect(close.href).toBe("/safe")
  })

  test("unwinds a multi-hop chain one close at a time, restoring deep-entry intent", () => {
    const automationsEntry = surfaceEntryState({
      location: { pathname: "/dir123/session/ses_1", search: "" },
      automationID: "auto_1",
    })
    const settingsEntry = surfaceEntryState({
      location: { pathname: "/automations", search: "", state: automationsEntry },
    })
    const first = resolveSurfaceClose({ state: settingsEntry, validateOrigin: () => true, fallback: "/" })
    expect(first.href).toBe("/automations")
    expect(first.state?.automationID).toBe("auto_1")
    const second = resolveSurfaceClose({ state: first.state, validateOrigin: () => true, fallback: "/" })
    expect(second.href).toBe("/dir123/session/ses_1")
    expect(second.state).toBeUndefined()
  })

  test("honors a surface-route origin without validation", () => {
    const settingsEntry = surfaceEntryState({
      location: { pathname: "/skills", search: "" },
    })
    const close = resolveSurfaceClose({ state: settingsEntry, validateOrigin: () => false, fallback: "/" })
    expect(close.href).toBe("/skills")
  })
})
