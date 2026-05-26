import { afterEach, describe, expect, mock, spyOn, test, vi } from "bun:test"
import {
  forceOpenAllDetails,
  preserveDetailsOpenState,
  resolveLinkAction,
  rewriteTaskListsForTest,
  sanitizeConfig,
  sanitizeForTest,
} from "./markdown"
import { ensureCodeWrapper, markCodeLinks, setupCodeCopy } from "./markdown-code-tools"

const originalClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
const originalError = console.error

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(Navigator.prototype, "clipboard", originalClipboard)
  } else {
    Reflect.deleteProperty(Navigator.prototype, "clipboard")
  }
  console.error = originalError
})

function setClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(Navigator.prototype, "clipboard", {
    configurable: true,
    get: () => ({ writeText }),
  })
}

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

describe("markdown code decoration", () => {
  test("wraps code blocks with one copy button", () => {
    document.body.innerHTML = "<pre><code>echo hi</code></pre>"
    const block = document.querySelector("pre")!
    const labels = { copy: "Copy", copied: "Copied" }

    ensureCodeWrapper(block, labels)
    ensureCodeWrapper(block, labels)

    const wrapper = document.querySelector('[data-component="markdown-code"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper!.querySelectorAll('[data-slot="markdown-copy-button"]')).toHaveLength(1)
    expect(wrapper!.textContent).toContain("echo hi")
  })

  test("marks inline code URLs and unwraps them when no longer URL-shaped", () => {
    document.body.innerHTML = "<p><code>https://example.com/readme</code></p>"
    markCodeLinks(document.body as HTMLDivElement)

    const link = document.querySelector("a.external-link")!
    expect(link).not.toBeNull()
    expect(link.getAttribute("href")).toBe("https://example.com/readme")

    const code = link.querySelector("code")!
    code.textContent = "not a url"
    markCodeLinks(document.body as HTMLDivElement)

    expect(document.querySelector("a.external-link")).toBeNull()
    expect(document.querySelector("code")!.textContent).toBe("not a url")
  })

  test("leaves inline code inside existing markdown links unchanged", () => {
    document.body.innerHTML = '<p><a href="https://example.com"><code>https://example.com</code></a></p>'
    markCodeLinks(document.body as HTMLDivElement)

    expect(document.querySelectorAll("a")).toHaveLength(1)
    expect(document.querySelector("a")!.classList.contains("external-link")).toBe(false)
    expect(document.querySelector("a > code")!.textContent).toBe("https://example.com")
  })

  test("copy button reports clipboard failures without entering copied state", async () => {
    const error = new Error("denied")
    const writeText = mock(async () => {
      throw error
    })
    const consoleError = mock(() => undefined)
    console.error = consoleError as typeof console.error
    setClipboard(writeText)

    document.body.innerHTML =
      '<div data-component="markdown-code"><pre><code>echo hi</code></pre><button type="button" data-slot="markdown-copy-button">Copy</button></div>'
    const cleanup = setupCodeCopy(document.body as HTMLDivElement, () => ({ copy: "Copy", copied: "Copied" }))
    const button = document.querySelector("button")!

    button.click()
    await Promise.resolve()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith("echo hi")
    expect(consoleError).toHaveBeenCalledWith("Clipboard copy failed", error)
    expect(button.hasAttribute("data-copied")).toBe(false)

    cleanup()
  })

  test("copy button resets with current labels and clears the finished timer", async () => {
    vi.useFakeTimers()
    try {
      const writeText = mock(async () => undefined)
      setClipboard(writeText)
      let copyLabel = "Copy"

      document.body.innerHTML =
        '<div data-component="markdown-code"><pre><code>echo hi</code></pre><button type="button" data-slot="markdown-copy-button">Copy</button></div>'
      const cleanup = setupCodeCopy(document.body as HTMLDivElement, () => ({
        copy: copyLabel,
        copied: "Copied",
      }))
      const button = document.querySelector("button")!

      button.click()
      await Promise.resolve()
      await Promise.resolve()

      expect(button.getAttribute("aria-label")).toBe("Copied")

      copyLabel = "Copy now"
      vi.advanceTimersByTime(2000)

      expect(button.hasAttribute("data-copied")).toBe(false)
      expect(button.getAttribute("aria-label")).toBe("Copy now")

      button.click()
      await Promise.resolve()
      await Promise.resolve()

      expect(writeText).toHaveBeenCalledTimes(2)
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  test("hovering the copy button shows a tooltip on document.body and hides on leave", () => {
    document.body.innerHTML =
      '<div data-component="markdown-code"><pre><code>echo hi</code></pre><button type="button" data-slot="markdown-copy-button" data-tooltip="Copy to clipboard">Copy</button></div>'
    const cleanup = setupCodeCopy(document.body as HTMLDivElement, () => ({
      copy: "Copy to clipboard",
      copied: "Copied",
    }))
    const button = document.querySelector("button")!

    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    const tip = document.querySelector('[data-slot="markdown-copy-tooltip"]')
    expect(tip).not.toBeNull()
    expect(tip!.getAttribute("data-show")).toBe("true")
    expect(tip!.textContent).toBe("Copy to clipboard")

    button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    expect(tip!.getAttribute("data-show")).toBeNull()

    cleanup()
  })

  test("dismisses the tooltip when its code block is removed from the DOM", async () => {
    document.body.innerHTML =
      '<div data-component="markdown-code"><pre><code>echo hi</code></pre><button type="button" data-slot="markdown-copy-button" data-tooltip="Copy to clipboard">Copy</button></div>'
    const cleanup = setupCodeCopy(document.body as HTMLDivElement, () => ({
      copy: "Copy to clipboard",
      copied: "Copied",
    }))
    const button = document.querySelector("button")!

    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    const tip = document.querySelector('[data-slot="markdown-copy-tooltip"]')!
    expect(tip.getAttribute("data-show")).toBe("true")

    // Markdown clears/re-renders content without any mouse or focus event;
    // the MutationObserver must dismiss the now-orphaned tooltip.
    document.querySelector('[data-component="markdown-code"]')!.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tip.getAttribute("data-show")).toBeNull()
    cleanup()
  })

  test("keyboard copy keeps the tooltip after the reset timer while the button stays focused", async () => {
    vi.useFakeTimers()
    try {
      const writeText = mock(async () => undefined)
      setClipboard(writeText)

      document.body.innerHTML =
        '<div data-component="markdown-code"><pre><code>echo hi</code></pre><button type="button" data-slot="markdown-copy-button" data-tooltip="Copy">Copy</button></div>'
      const cleanup = setupCodeCopy(document.body as HTMLDivElement, () => ({
        copy: "Copy",
        copied: "Copied",
      }))
      const button = document.querySelector("button")!

      button.focus()
      button.click()
      await Promise.resolve()
      await Promise.resolve()

      const tip = document.querySelector('[data-slot="markdown-copy-tooltip"]')!
      expect(tip.getAttribute("data-show")).toBe("true")
      expect(tip.textContent).toBe("Copied")

      vi.advanceTimersByTime(2000)

      // Button is still focused (no hover), so the tooltip stays and the label
      // reverts to copy instead of disappearing.
      expect(document.activeElement).toBe(button)
      expect(tip.getAttribute("data-show")).toBe("true")
      expect(tip.textContent).toBe("Copy")
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  test("reference-counts the global scroll/resize listeners across instances", () => {
    const addSpy = spyOn(window, "addEventListener")
    const removeSpy = spyOn(window, "removeEventListener")
    try {
      const countScroll = (spy: typeof addSpy) =>
        spy.mock.calls.filter((args) => args[0] === "scroll").length

      const root1 = document.createElement("div")
      const root2 = document.createElement("div")
      document.body.append(root1, root2)
      const labels = () => ({ copy: "Copy", copied: "Copied" })

      const addsBefore = countScroll(addSpy)
      const cleanup1 = setupCodeCopy(root1 as HTMLDivElement, labels)
      const cleanup2 = setupCodeCopy(root2 as HTMLDivElement, labels)
      // Two instances, but the global scroll listener is registered only once.
      expect(countScroll(addSpy) - addsBefore).toBe(1)

      const removesBefore = countScroll(removeSpy)
      cleanup1()
      // One instance still holds the ref, so nothing is removed yet.
      expect(countScroll(removeSpy) - removesBefore).toBe(0)
      cleanup2()
      // Last instance gone, the single global listener is removed.
      expect(countScroll(removeSpy) - removesBefore).toBe(1)
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
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
