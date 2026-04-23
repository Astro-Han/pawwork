import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("assistant part renderers capture item values before passing them to Part", () => {
  const source = readFileSync(new URL("./message-part.tsx", import.meta.url), "utf8")

  expect(source).toContain("function latestDefined")
  expect(source).not.toContain("<Show when={item()} keyed>")
  expect(source).not.toMatch(/part=\{item\(\)!?\}/)
  expect(source).not.toMatch(/defaultOpen=\{partDefaultOpen\(item\(\)!?/)
  expect(source).not.toMatch(/message=\{message\(\)!?\}/)
})

test("tool file accordions account for tool content gap in sticky offset", () => {
  const source = readFileSync(new URL("./message-part.tsx", import.meta.url), "utf8")

  expect(source).toContain('style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}')
  expect(source).not.toContain('style={{ "--sticky-accordion-offset": "40px" }}')
})
