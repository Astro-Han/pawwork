import { describe, expect, test } from "bun:test"
import {
  forceOpenAllDetails,
  preserveDetailsOpenState,
  renderBlocksToContainerForTest,
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
  test("URI regex rejects protocol-relative // (defense-in-depth with click router)", () => {
    const re = sanitizeConfig.ALLOWED_URI_REGEXP
    expect(re.test("//evil.com/x")).toBe(false)
    expect(sanitizeForTest('<a href="//evil.com/x">x</a>')).not.toContain("href")
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
  test("groups label + nested blocks into a single flex sibling of the icon", () => {
    document.body.innerHTML =
      '<ul><li><input type="checkbox" disabled> parent<ul><li>nested</li></ul></li></ul>'
    const li = document.querySelector("li")!
    rewriteTaskListsForTest(document.body)
    // li direct children must be exactly [svg, label-wrapper]; otherwise
    // nested <ul> would render to the right of the icon as a flex sibling.
    const direct = Array.from(li.children)
    expect(direct).toHaveLength(2)
    expect(direct[0]!.tagName.toLowerCase()).toBe("svg")
    expect(direct[1]!.getAttribute("data-slot")).toBe("task-label")
    // Nested ul moved into the label wrapper, not orphaned at li level.
    expect(direct[1]!.querySelector("ul")).not.toBeNull()
    expect(direct[1]!.textContent).toContain("parent")
    expect(direct[1]!.textContent).toContain("nested")
  })
  test("strips leading whitespace from loose-list paragraph first text", () => {
    document.body.innerHTML =
      '<ul><li><p><input type="checkbox" disabled> loose label</p></li></ul>'
    rewriteTaskListsForTest(document.body)
    const label = document.querySelector('[data-slot="task-label"]')!
    // Inside loose list, the leading text lives in the first <p>'s firstChild.
    const p = label.querySelector("p")!
    expect(p.firstChild?.textContent?.startsWith(" ")).toBe(false)
    expect(p.textContent).toBe("loose label")
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
  test("Windows drive-letter absolute path → reveal", () => {
    expect(resolveLinkAction("C:\\repo\\file.ts")).toEqual({ kind: "reveal", path: "C:\\repo\\file.ts" })
    expect(resolveLinkAction("D:/code/foo.ts")).toEqual({ kind: "reveal", path: "D:/code/foo.ts" })
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

describe("renderBlocksToContainer — dirty tail rendering contract", () => {
  // The helper takes a flat list of prepared blocks (already sanitized to HTML)
  // and writes them into the container as one child wrapper per block. Stable
  // blocks whose key + html have not changed since the previous render skip
  // morphdom entirely; only dirty (or content-changed) wrappers are diffed.
  // This is the DOM-side of the C-min dirty-tail contract.

  const labels = { copy: "Copy", copied: "Copied" }

  test("first render writes one wrapper per block in order", () => {
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<p>alpha</p>" },
        { key: "1:live", stable: false, html: "<p>beta tail</p>" },
      ],
      labels,
    )
    expect(container.children).toHaveLength(2)
    expect(container.children[0]!.textContent).toBe("alpha")
    expect(container.children[1]!.textContent).toBe("beta tail")
  })

  test("streaming progression: stable head wrapper element is preserved across renders, dirty tail updates", () => {
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<p>head paragraph</p>" },
        { key: "1:live", stable: false, html: "<p>tail begin</p>" },
      ],
      labels,
    )
    const headWrap = container.children[0]
    const tailWrap = container.children[1]
    expect(headWrap).toBeDefined()
    expect(tailWrap).toBeDefined()

    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<p>head paragraph</p>" },
        { key: "1:live", stable: false, html: "<p>tail extended now</p>" },
      ],
      labels,
    )
    // Head wrapper identity preserved (no DOM churn on stable block).
    expect(container.children[0]).toBe(headWrap)
    // Tail wrapper identity also preserved; only its inner content morphs.
    expect(container.children[1]).toBe(tailWrap)
    expect(tailWrap!.textContent).toBe("tail extended now")
  })

  test("abort consistency: final full render replaces partial tail with complete content, no orphan wrappers", () => {
    const container = document.createElement("div")
    // Streaming phase
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:live-head", stable: true, html: "<p>para A</p>" },
        { key: "1:live-tail", stable: false, html: "<p>para B parti</p>" },
      ],
      labels,
    )
    expect(container.children).toHaveLength(2)

    // Abort / SSE close → PacedMarkdown forces streaming=false, Markdown
    // re-renders the full text as one stable block.
    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<p>para A</p><p>para B complete</p>" }],
      labels,
    )

    expect(container.children).toHaveLength(1)
    expect(container.textContent).toBe("para Apara B complete")
    // The previous tail wrapper must not linger as a sibling.
    expect(container.querySelectorAll("p")).toHaveLength(2)
  })

  test("final render after partial streaming clears tail-only state", () => {
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [{ key: "0:live", stable: false, html: "<p>still streaming</p>" }],
      labels,
    )

    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<p>final complete content</p>" }],
      labels,
    )

    expect(container.children).toHaveLength(1)
    expect(container.firstElementChild!.textContent).toBe("final complete content")
  })

  test("preserves user collapse on stable details block across re-render", () => {
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<details><summary>x</summary>y</details>" },
        { key: "1:live", stable: false, html: "<p>tail</p>" },
      ],
      labels,
    )

    const details = container.querySelector("details")!
    // forceOpenAllDetails ran on first render — user collapses.
    details.removeAttribute("open")

    // Same stable head, advance tail.
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<details><summary>x</summary>y</details>" },
        { key: "1:live", stable: false, html: "<p>tail extended</p>" },
      ],
      labels,
    )

    // Stable head is skipped entirely — the user's collapsed state survives.
    expect(container.querySelector("details")!.hasAttribute("open")).toBe(false)
  })

  test("removing trailing dirty tail (e.g. tail merged into stable head on final render) does not leave orphans", () => {
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<p>head</p>" },
        { key: "1:live", stable: false, html: "<p>tail draft</p>" },
        { key: "2:live", stable: false, html: "<p>even tailer</p>" },
      ],
      labels,
    )
    expect(container.children).toHaveLength(3)

    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<p>head</p><p>tail final</p>" }],
      labels,
    )

    expect(container.children).toHaveLength(1)
    expect(container.textContent).toBe("headtail final")
  })

  test("same stable key but changed html: DOM content must update (no over-skip)", () => {
    // Defends against an implementation that keys only on `key` and skips
    // diff entirely when keys match — that would freeze retry / truncate /
    // hash-drift cases on the previous render's content. The wrapper element
    // may or may not be reused; what must hold is the visible text reflecting
    // the latest html for that key.
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<p>A</p>" }],
      labels,
    )
    expect(container.textContent).toBe("A")

    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<p>A changed</p>" }],
      labels,
    )
    expect(container.textContent).toBe("A changed")
  })

  test("labels change (i18n switch) invalidates copy button decoration without duplicating buttons", () => {
    // Stable skip cannot key on (key + html) alone — copy button labels are
    // a function of the i18n locale, and stale aria-label / tooltip after
    // a language switch is a W1 gate regression. Block skip fingerprint must
    // include `labels.copy` / `labels.copied` so a labels change re-decorates
    // the block exactly once.
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<pre><code>const x = 1</code></pre>" }],
      { copy: "Copy", copied: "Copied" },
    )
    const buttonsEn = container.querySelectorAll('[data-slot="markdown-copy-button"]')
    expect(buttonsEn).toHaveLength(1)
    expect(buttonsEn[0]!.getAttribute("aria-label")).toBe("Copy")

    // Switch locale: same key, same html, different labels.
    renderBlocksToContainerForTest(
      container,
      [{ key: "0:full", stable: true, html: "<pre><code>const x = 1</code></pre>" }],
      { copy: "复制", copied: "已复制" },
    )
    const buttonsZh = container.querySelectorAll('[data-slot="markdown-copy-button"]')
    expect(buttonsZh).toHaveLength(1)
    expect(buttonsZh[0]!.getAttribute("aria-label")).toBe("复制")
  })

  test("code copy button is wired exactly once per stable code block after re-render", () => {
    const container = document.createElement("div")
    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<pre><code>const x = 1</code></pre>" },
        { key: "1:live", stable: false, html: "<p>tail</p>" },
      ],
      labels,
    )

    renderBlocksToContainerForTest(
      container,
      [
        { key: "0:full", stable: true, html: "<pre><code>const x = 1</code></pre>" },
        { key: "1:live", stable: false, html: "<p>tail extended</p>" },
      ],
      labels,
    )

    // Skip on stable block means we don't re-wrap or duplicate copy buttons.
    const buttons = container.querySelectorAll('[data-slot="markdown-copy-button"]')
    expect(buttons).toHaveLength(1)
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
