import { describe, expect, test } from "bun:test"

const root = new URL("../../../../", import.meta.url)
const read = async (path: string) => Bun.file(new URL(path, root)).text()

describe("model picker visual regression guard", () => {
  test("model tooltip content inherits the tooltip text color", async () => {
    const source = await read("packages/app/src/components/model-tooltip.tsx")

    expect(source).not.toContain("text-fg-on-brand")
  })

  test("model list active row uses a visible hover surface", async () => {
    const source = await read("packages/ui/src/components/list.css")

    expect(source).toContain('&[data-active="true"]')
    expect(source).toMatch(/&\[data-active="true"\]\s*\{[\s\S]*?background:\s*var\(--surface-sunken\)/)
    expect(source).not.toMatch(/&\[data-active="true"\]\s*\{[\s\S]*?background:\s*var\(--surface-raised\)/)
  })

  test("prompt workspace and variant menu rows use a visible hover surface", async () => {
    const workspace = await read("packages/app/src/components/prompt-input/workspace-chip.tsx")
    const promptInput = await read("packages/app/src/components/prompt-input.tsx")
    const select = await read("packages/ui/src/components/select.css")

    expect(workspace).not.toContain("hover:bg-surface-raised")
    expect(workspace).not.toContain("focus-visible:bg-surface-raised")
    expect(promptInput).not.toContain("hover:bg-surface-raised focus-visible:bg-surface-raised")
    expect(select).not.toMatch(/&\[data-highlighted\]\s*\{[\s\S]*?background:\s*var\(--surface-raised\)/)
    expect(select).not.toMatch(/&:hover\s*\{[\s\S]*?background:\s*var\(--surface-raised\)/)
  })
})
