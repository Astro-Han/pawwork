import { describe, expect, test } from "bun:test"
import {
  forceOpenAllDetails,
  preserveDetailsOpenState,
  resolveLinkAction,
  rewriteTaskListsForTest,
  sanitizeConfig,
  sanitizeForTest,
} from "./markdown"

describe("DOMPurify whitelist config", () => {
  test("forbids unsafe tags", () => {
    expect(sanitizeConfig.FORBID_TAGS).toContain("script")
    expect(sanitizeConfig.FORBID_TAGS).toContain("iframe")
    expect(sanitizeConfig.FORBID_TAGS).toContain("style")
    expect(sanitizeConfig.FORBID_TAGS).toContain("form")
    expect(sanitizeConfig.FORBID_TAGS).toContain("object")
    expect(sanitizeConfig.FORBID_TAGS).toContain("embed")
  })
  test("permits input only as GFM checkbox (handled via uponSanitizeElement hook)", () => {
    expect(sanitizeConfig.FORBID_TAGS).not.toContain("input")
  })
  test("forbids unsafe text content", () => {
    expect(sanitizeConfig.FORBID_CONTENTS).toContain("script")
    expect(sanitizeConfig.FORBID_CONTENTS).toContain("iframe")
    expect(sanitizeConfig.FORBID_CONTENTS).toContain("style")
  })
  test("URI regex accepts http(s) / mailto / file / relative paths", () => {
    const re = sanitizeConfig.ALLOWED_URI_REGEXP
    expect(re.test("https://example.com")).toBe(true)
    expect(re.test("http://example.com")).toBe(true)
    expect(re.test("mailto:hi@x.com")).toBe(true)
    expect(re.test("file:///tmp/x")).toBe(true)
    expect(re.test("/abs/path")).toBe(true)
    expect(re.test("./rel/path")).toBe(true)
    expect(re.test("../up/path")).toBe(true)
    expect(re.test("relative/path")).toBe(true)
    expect(re.test("#anchor")).toBe(true)
  })
  test("URI regex rejects javascript: / data: / vbscript:", () => {
    const re = sanitizeConfig.ALLOWED_URI_REGEXP
    expect(re.test("javascript:alert(1)")).toBe(false)
    expect(re.test("data:text/html,foo")).toBe(false)
    expect(re.test("vbscript:msgbox")).toBe(false)
  })
})

describe("task list svg rendering", () => {
  test("replaces unchecked input with circle svg + tags li", () => {
    document.body.innerHTML = '<ul><li><input type="checkbox" disabled> read</li></ul>'
    const li = document.querySelector("li")!
    rewriteTaskListsForTest(document.body)
    expect(li.classList.contains("task-item")).toBe(true)
    expect(li.querySelector("input")).toBeNull()
    const svg = li.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute("data-state")).toBe("unchecked")
  })
  test("replaces checked input with circle-check svg", () => {
    document.body.innerHTML = '<ul><li><input type="checkbox" disabled checked> done</li></ul>'
    rewriteTaskListsForTest(document.body)
    const svg = document.querySelector('svg[data-state="checked"]')
    expect(svg).not.toBeNull()
    expect(svg!.querySelector("path")).not.toBeNull()
  })
  test("preserves label text after checkbox", () => {
    document.body.innerHTML = '<ul><li><input type="checkbox" disabled> read the spec</li></ul>'
    rewriteTaskListsForTest(document.body)
    expect(document.body.textContent).toContain("read the spec")
  })
  test("does not tag sibling LI without checkbox", () => {
    document.body.innerHTML =
      '<ul><li><input type="checkbox" disabled> task</li><li>plain bullet</li></ul>'
    rewriteTaskListsForTest(document.body)
    const items = document.querySelectorAll("li")
    expect(items[0]!.classList.contains("task-item")).toBe(true)
    expect(items[1]!.classList.contains("task-item")).toBe(false)
  })
  test("handles loose-list paragraph wrap", () => {
    document.body.innerHTML =
      '<ul><li><p><input type="checkbox" disabled> loose item</p></li></ul>'
    const li = document.querySelector("li")!
    rewriteTaskListsForTest(document.body)
    expect(li.classList.contains("task-item")).toBe(true)
    expect(li.querySelector("input")).toBeNull()
    expect(li.querySelector("svg")).not.toBeNull()
  })
  test("sanitize-then-decorate keeps GFM checkbox alive", () => {
    const cleaned = sanitizeForTest(
      '<ul><li><input disabled="" type="checkbox"> task</li></ul>',
    )
    const root = document.createElement("div")
    root.innerHTML = cleaned
    rewriteTaskListsForTest(root)
    const li = root.querySelector("li")!
    expect(li.classList.contains("task-item")).toBe(true)
    expect(li.querySelector("svg")).not.toBeNull()
  })
  test("sanitize strips non-checkbox inputs", () => {
    const cleaned = sanitizeForTest('<input type="text" name="leak">')
    expect(cleaned).not.toContain("<input")
  })
})

describe("link action routing", () => {
  test("https → external", () => {
    expect(resolveLinkAction("https://example.com")).toEqual({ kind: "external", url: "https://example.com" })
  })
  test("http → external", () => {
    expect(resolveLinkAction("http://example.com")).toEqual({ kind: "external", url: "http://example.com" })
  })
  test("mailto: → external", () => {
    expect(resolveLinkAction("mailto:hi@x.com")).toEqual({ kind: "external", url: "mailto:hi@x.com" })
  })
  test("relative repo path → reveal", () => {
    expect(resolveLinkAction("packages/ui/src/foo.ts")).toEqual({
      kind: "reveal",
      path: "packages/ui/src/foo.ts",
    })
  })
  test("absolute path → reveal", () => {
    expect(resolveLinkAction("/Users/u/p/foo.ts")).toEqual({ kind: "reveal", path: "/Users/u/p/foo.ts" })
  })
  test("anchor-only stays default", () => {
    expect(resolveLinkAction("#section")).toEqual({ kind: "anchor", url: "#section" })
  })
  test("protocol-relative // blocks (cannot be local path)", () => {
    expect(resolveLinkAction("//evil.com/x")).toEqual({ kind: "block" })
  })
  test("javascript: rejected", () => {
    expect(resolveLinkAction("javascript:alert(1)")).toEqual({ kind: "block" })
  })
  test("data: rejected", () => {
    expect(resolveLinkAction("data:text/html,foo")).toEqual({ kind: "block" })
  })
  test("vbscript: rejected", () => {
    expect(resolveLinkAction("vbscript:msgbox")).toEqual({ kind: "block" })
  })
  test("non-dangerous custom scheme routes external (sanitize allowlist gates the surface)", () => {
    expect(resolveLinkAction("vscode://file/foo")).toEqual({ kind: "external", url: "vscode://file/foo" })
    expect(resolveLinkAction("tel:+15551234")).toEqual({ kind: "external", url: "tel:+15551234" })
  })
  test("empty href blocks", () => {
    expect(resolveLinkAction("")).toEqual({ kind: "block" })
  })
  test("trims surrounding whitespace", () => {
    expect(resolveLinkAction("  https://x.com  ")).toEqual({ kind: "external", url: "https://x.com" })
  })
})

describe("forceOpenAllDetails (streaming UX)", () => {
  test("opens all details elements", () => {
    document.body.innerHTML =
      "<details><summary>A</summary>x</details><details><summary>B</summary>y</details>"
    forceOpenAllDetails(document.body)
    const all = document.querySelectorAll("details")
    expect(all[0]!.hasAttribute("open")).toBe(true)
    expect(all[1]!.hasAttribute("open")).toBe(true)
  })
  test("idempotent on already-open details", () => {
    document.body.innerHTML = "<details open><summary>A</summary>x</details>"
    forceOpenAllDetails(document.body)
    expect(document.querySelector("details")!.hasAttribute("open")).toBe(true)
  })
  test("opens nested details too", () => {
    document.body.innerHTML =
      "<details><summary>outer</summary><details><summary>inner</summary>x</details></details>"
    forceOpenAllDetails(document.body)
    const all = document.querySelectorAll("details")
    expect(all[0]!.hasAttribute("open")).toBe(true)
    expect(all[1]!.hasAttribute("open")).toBe(true)
  })
})

describe("preserveDetailsOpenState (user collapse survives re-render)", () => {
  test("propagates open from fromEl to toEl", () => {
    const fromEl = document.createElement("details")
    fromEl.setAttribute("open", "")
    const toEl = document.createElement("details")
    preserveDetailsOpenState(fromEl, toEl)
    expect(toEl.hasAttribute("open")).toBe(true)
  })
  test("clears open on toEl when fromEl is collapsed by user", () => {
    const fromEl = document.createElement("details")
    const toEl = document.createElement("details")
    toEl.setAttribute("open", "") // force-open default
    preserveDetailsOpenState(fromEl, toEl)
    expect(toEl.hasAttribute("open")).toBe(false)
  })
  test("ignores non-details pairs", () => {
    const fromEl = document.createElement("div")
    const toEl = document.createElement("details")
    preserveDetailsOpenState(fromEl, toEl)
    expect(toEl.hasAttribute("open")).toBe(false)
  })
})
