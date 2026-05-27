import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..")

function read(path: string) {
  return readFileSync(join(REPO_ROOT, path), "utf-8")
}

function block(source: string, selector: string) {
  const index = source.indexOf(selector)
  expect(index, `${selector} should exist`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf("{", index)
  let depth = 0
  for (let pos = open; pos < source.length; pos++) {
    if (source[pos] === "{") depth++
    if (source[pos] === "}") depth--
    if (depth === 0) return source.slice(open + 1, pos)
  }
  throw new Error(`unterminated block for ${selector}`)
}

function expectNoSourceMatch(pattern: RegExp, files: string[]) {
  const hits = files.flatMap((file) => {
    const source = read(file)
    return pattern.test(source) ? [file] : []
  })
  expect(hits).toEqual([])
}

describe("#642 PR3 typography role semantics", () => {
  test("body-like multi-line contexts use body line-height, not caption line-height", () => {
    const messagePart = read("packages/ui/src/components/message-part.css")

    expect(block(messagePart, '[data-component="reasoning-body"] [data-component="markdown"]')).toContain(
      "line-height: var(--line-height-body)",
    )
    expect(block(messagePart, '[data-slot="message-part-todo-content"]')).toContain(
      "line-height: var(--line-height-body)",
    )
  })

  test("list and form rows use body size and semantic emphasis instead of h3 fragments", () => {
    const picker = read("packages/ui/src/components/picker.css")
    const switchCss = read("packages/ui/src/components/switch.css")

    expect(block(picker, "[data-picker-item]")).toContain("font-size: var(--font-size-body)")
    expect(block(picker, "[data-picker-item]:where([data-selected])")).toContain(
      "font-weight: var(--font-weight-emphasis)",
    )
    expect(block(switchCss, '[data-slot="switch-label"]')).toContain("font-size: var(--font-size-body)")
  })

  test("permission patterns remain compact mono code", () => {
    const permissionDock = read("packages/app/src/pages/session/composer/session-permission-dock.tsx")
    const messagePart = read("packages/ui/src/components/message-part.css")

    expect(permissionDock).toContain('class="text-mono-small text-fg-base break-all"')
    expect(block(messagePart, '[data-slot="permission-patterns"]')).not.toContain("code {")
  })

  test("theme roles expose emphasis weight and cjk tracking tokens", () => {
    const theme = read("packages/ui/src/styles/theme.css")
    const tailwind = read("packages/ui/src/styles/tailwind/index.css")

    expect(theme).toContain("--font-weight-emphasis: 500;")
    expect(theme).toContain("--letter-spacing-cjk: 0;")
    expect(tailwind).toContain("@utility font-emphasis")
    expect(tailwind).toContain("@utility tracking-cjk")
  })

  test("app source does not bypass role utilities with arbitrary typography token fragments", () => {
    expectNoSourceMatch(/font-\[var\(--font-weight-[^)]+\)\]/, [
      "packages/app/src/app.tsx",
      "packages/app/src/pages/error.tsx",
      "packages/app/src/pages/layout/pawwork-sidebar.tsx",
      "packages/app/src/pages/layout/sidebar-items.tsx",
      "packages/app/src/pages/session/composer/session-composer-region.tsx",
    ])
    expectNoSourceMatch(/tracking-\[0\]/, ["packages/app/src/components/session/session-new-view.tsx"])
  })

  test("desktop renderer uses body typography as the document default", () => {
    expect(read("packages/desktop-electron/src/renderer/index.html")).toContain("text-body")
    expect(read("packages/desktop-electron/src/renderer/loading.html")).toContain("text-body")
  })

  test("role line-height comments do not preserve stale pre-role percentages", () => {
    expectNoSourceMatch(/142\.857|166\.667|171\.429/, [
      "packages/ui/src/components/dialog.css",
      "packages/ui/src/components/accordion.css",
      "packages/ui/src/components/collapsible.css",
      "packages/ui/src/components/list.css",
      "packages/ui/src/components/tabs.css",
      "packages/ui/src/components/toast.css",
    ])
  })
})
