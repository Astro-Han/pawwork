import { describe, expect, test } from "bun:test"
import {
  clearDataReloadAction,
  computeViewBounds,
  deriveBrowserState,
  displayDecision,
  parseNavigable,
  safeExternalUrl,
  type BrowserStateSnapshot,
} from "./logic"

describe("parseNavigable", () => {
  test("accepts http and https and normalizes", () => {
    expect(parseNavigable("https://a.com")).toBe("https://a.com/")
    expect(parseNavigable("http://a.com/x?q=1")).toBe("http://a.com/x?q=1")
  })

  test("rejects non-web schemes and garbage", () => {
    expect(parseNavigable("file:///etc/passwd")).toBeNull()
    expect(parseNavigable("javascript:alert(1)")).toBeNull()
    expect(parseNavigable("about:blank")).toBeNull()
    expect(parseNavigable("ftp://files.example.com")).toBeNull()
    expect(parseNavigable("not a url")).toBeNull()
    expect(parseNavigable("")).toBeNull()
  })
})

describe("safeExternalUrl", () => {
  test("allows mailto and tel (case-insensitive)", () => {
    expect(safeExternalUrl("mailto:a@b.com")).toBe("mailto:a@b.com")
    expect(safeExternalUrl("tel:+15551234")).toBe("tel:+15551234")
    expect(safeExternalUrl("MAILTO:a@b.com")).toBe("MAILTO:a@b.com")
  })

  test("drops file, custom app, javascript, and schemeless inputs", () => {
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull()
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull()
    expect(safeExternalUrl("slack://open?team=T1")).toBeNull()
    expect(safeExternalUrl("example.com")).toBeNull()
    expect(safeExternalUrl("")).toBeNull()
  })
})

describe("computeViewBounds", () => {
  test("rounds and passes through at zoom 1", () => {
    expect(computeViewBounds({ x: 10.4, y: 20.6, width: 300.5, height: 400.2 }, 1)).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 400,
    })
  })

  test("scales by the zoom factor", () => {
    expect(computeViewBounds({ x: 10, y: 20, width: 100, height: 200 }, 1.5)).toEqual({
      x: 15,
      y: 30,
      width: 150,
      height: 300,
    })
  })

  test("guards a non-positive zoom and clamps negative sizes", () => {
    expect(computeViewBounds({ x: 0, y: 0, width: 50, height: 50 }, 0)).toEqual({ x: 0, y: 0, width: 50, height: 50 })
    expect(computeViewBounds({ x: 0, y: 0, width: -5, height: -5 }, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe("deriveBrowserState", () => {
  const snap = (over: Partial<BrowserStateSnapshot>): BrowserStateSnapshot => ({
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    favicon: null,
    ...over,
  })

  test("flags hasPage false for empty and about: URLs", () => {
    expect(deriveBrowserState(snap({ url: "" })).hasPage).toBe(false)
    expect(deriveBrowserState(snap({ url: "about:blank" })).hasPage).toBe(false)
    expect(deriveBrowserState(snap({ url: "https://a.com/" })).hasPage).toBe(true)
  })

  test("derives secure from the https scheme", () => {
    expect(deriveBrowserState(snap({ url: "https://a.com/" })).secure).toBe(true)
    expect(deriveBrowserState(snap({ url: "http://a.com/" })).secure).toBe(false)
  })

  test("passes navigation flags through", () => {
    const state = deriveBrowserState(
      snap({ url: "https://a.com/", title: "A", canGoBack: true, canGoForward: false, loading: true, favicon: "f" }),
    )
    expect(state).toMatchObject({ title: "A", canGoBack: true, canGoForward: false, loading: true, favicon: "f" })
  })
})

describe("clearDataReloadAction", () => {
  test("reloads immediately when a page is loaded", () => {
    expect(clearDataReloadAction({ hasPage: true, loading: false })).toBe("now")
    expect(clearDataReloadAction({ hasPage: true, loading: true })).toBe("now")
  })

  test("defers one reload when the first navigation is still in flight", () => {
    // hasPage stays false until the first load commits; the in-flight request
    // carries the pre-clear cookies, so it must reload once it settles.
    expect(clearDataReloadAction({ hasPage: false, loading: true })).toBe("defer")
  })

  test("does nothing when idle with no page", () => {
    expect(clearDataReloadAction({ hasPage: false, loading: false })).toBe("none")
  })
})

describe("displayDecision", () => {
  test("the hosting window keeps showing the view, claim or not", () => {
    expect(displayDecision({ isHost: true, hasLiveHost: true, claim: false })).toBe("show")
    expect(displayDecision({ isHost: true, hasLiveHost: true, claim: true })).toBe("show")
  })

  test("attaching from nothing needs no claim", () => {
    // host is null (never displayed / released on window close) or destroyed:
    // whichever window legitimately shows the conversation may attach.
    expect(displayDecision({ isHost: false, hasLiveHost: false, claim: false })).toBe("show")
    expect(displayDecision({ isHost: false, hasLiveHost: false, claim: true })).toBe("show")
  })

  test("only a claiming push may take the display from a live host", () => {
    expect(displayDecision({ isHost: false, hasLiveHost: true, claim: true })).toBe("takeover")
  })

  test("a geometry tick from a non-host window is dropped, never a steal", () => {
    // The exact race this exists for: a resize frame in flight when the
    // display changed hands must not steal the view back.
    expect(displayDecision({ isHost: false, hasLiveHost: true, claim: false })).toBe("drop")
  })
})
