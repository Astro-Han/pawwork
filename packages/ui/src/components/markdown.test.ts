import { describe, expect, test } from "bun:test"
import { resolveLinkAction, rewriteTaskListsForTest, sanitizeConfig } from "./markdown"

describe("DOMPurify whitelist config", () => {
  test("forbids unsafe tags", () => {
    expect(sanitizeConfig.FORBID_TAGS).toContain("script")
    expect(sanitizeConfig.FORBID_TAGS).toContain("iframe")
    expect(sanitizeConfig.FORBID_TAGS).toContain("style")
    expect(sanitizeConfig.FORBID_TAGS).toContain("form")
    expect(sanitizeConfig.FORBID_TAGS).toContain("input")
    expect(sanitizeConfig.FORBID_TAGS).toContain("object")
    expect(sanitizeConfig.FORBID_TAGS).toContain("embed")
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
  test("replaces unchecked input with circle svg", () => {
    document.body.innerHTML = '<ul><li><input type="checkbox" disabled> read</li></ul>'
    const ul = document.querySelector("ul")!
    rewriteTaskListsForTest(document.body)
    expect(ul.classList.contains("task-list")).toBe(true)
    expect(ul.querySelector("input")).toBeNull()
    const svg = ul.querySelector("svg")
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
})

describe("link action routing", () => {
  test("https → external", () => {
    expect(resolveLinkAction("https://example.com")).toEqual({ kind: "external", url: "https://example.com" })
  })
  test("http → external", () => {
    expect(resolveLinkAction("http://example.com")).toEqual({ kind: "external", url: "http://example.com" })
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
  test("javascript: rejected", () => {
    expect(resolveLinkAction("javascript:alert(1)")).toEqual({ kind: "block" })
  })
  test("data: rejected", () => {
    expect(resolveLinkAction("data:text/html,foo")).toEqual({ kind: "block" })
  })
  test("empty href blocks", () => {
    expect(resolveLinkAction("")).toEqual({ kind: "block" })
  })
  test("trims surrounding whitespace", () => {
    expect(resolveLinkAction("  https://x.com  ")).toEqual({ kind: "external", url: "https://x.com" })
  })
})
