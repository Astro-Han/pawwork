import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("session review keeps metadata-only diff rows non-renderable but visible", () => {
  const source = readFileSync(new URL("./session-review.tsx", import.meta.url), "utf8")

  expect(source).toContain("!!mediaKindFromPath(diff.file) || diff.additions !== 0 || diff.deletions !== 0")
  expect(source).toContain("const renderableFiles = createMemo(() =>")
  expect(source).toContain(".filter(canRenderDiff)")
  expect(source).toContain(".map((diff) => diff.file)")
  expect(source).toContain("const hasOpenRenderableFiles = createMemo(() =>")
  expect(source).toContain("renderableFiles().some((file) => open().includes(file))")
  expect(source).toContain("const next = hasOpenRenderableFiles() ? [] : renderableFiles()")
  expect(source).toContain("<Match when={hasOpenRenderableFiles()}>")
  expect(source).toContain("const expanded = createMemo(() => diffCanRender() && open().includes(file))")
  expect(source).toContain("const diffCanRender = () => canRenderDiff(diff)")
  expect(source).toContain("value={file}")
  expect(source).toContain("disabled={!diffCanRender()}")
  expect(source).not.toContain('class="cursor-default"')
  expect(source).toContain("<Show when={diffCanRender()}>")
})
