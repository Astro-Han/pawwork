import { describe, expect, test } from "bun:test"
import { browserToolSubtitle, safeHttpUrl } from "../src/components/tool-info"

// One subtitle rule feeds BOTH the collapsed trow summary and every expanded
// browser card — and on the navigate card the value renders as a clickable
// <a href>, so safeHttpUrl is the sole guard between tool metadata and a
// live link.

describe("safeHttpUrl", () => {
  test("passes http(s) and drops every other scheme", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/")
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined()
    expect(safeHttpUrl("file:///etc/passwd")).toBeUndefined()
    expect(safeHttpUrl("about:blank")).toBeUndefined()
    expect(safeHttpUrl("data:text/html,hi")).toBeUndefined()
  })

  test("drops non-strings and unparseable values", () => {
    expect(safeHttpUrl(undefined)).toBeUndefined()
    expect(safeHttpUrl(42)).toBeUndefined()
    expect(safeHttpUrl("not a url")).toBeUndefined()
    expect(safeHttpUrl("")).toBeUndefined()
  })
})

describe("browserToolSubtitle", () => {
  test("navigate prefers the landed metadata url over the requested input url", () => {
    expect(
      browserToolSubtitle("browser_navigate", { url: "https://a.example/" }, { url: "https://b.example/landed" }),
    ).toBe("https://b.example/landed")
    expect(browserToolSubtitle("browser_navigate", { url: "https://a.example/" }, {})).toBe("https://a.example/")
    // A non-web url never becomes a subtitle (the card would link it).
    expect(browserToolSubtitle("browser_navigate", { url: "javascript:alert(1)" }, {})).toBeUndefined()
  })

  test("click and type show the literal ref", () => {
    expect(browserToolSubtitle("browser_click", { ref: "e12" })).toBe("e12")
    expect(browserToolSubtitle("browser_type", { ref: "e7", text: "hi" })).toBe("e7")
    expect(browserToolSubtitle("browser_click", {})).toBeUndefined()
  })

  test("wait falls back text -> selector -> fixed time", () => {
    expect(browserToolSubtitle("browser_wait", { text: "Done" })).toBe("Done")
    expect(browserToolSubtitle("browser_wait", { selector: "#x" })).toBe("#x")
    expect(browserToolSubtitle("browser_wait", { time: 2 })).toBe("2s")
    expect(browserToolSubtitle("browser_wait", {})).toBeUndefined()
  })

  test("extract prefers the selector, then the page url", () => {
    expect(browserToolSubtitle("browser_extract", { selector: "main" }, { url: "https://a.example/" })).toBe("main")
    expect(browserToolSubtitle("browser_extract", {}, { url: "https://a.example/" })).toBe("https://a.example/")
  })

  test("snapshot and screenshot show the page url, filtered", () => {
    expect(browserToolSubtitle("browser_snapshot", {}, { url: "https://a.example/" })).toBe("https://a.example/")
    expect(browserToolSubtitle("browser_screenshot", {}, { url: "about:blank" })).toBeUndefined()
  })
})
