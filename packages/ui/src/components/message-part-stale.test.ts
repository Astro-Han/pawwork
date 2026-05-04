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

// Cancelled question variant must identify the case via metadata.interrupted
// (written by processor cleanup) so the check stays decoupled from the exact
// backend error string. See #419.
test("question tool error renders interrupted variant via metadata.interrupted", () => {
  const source = readFileSync(new URL("./message-part.tsx", import.meta.url), "utf8")

  expect(source).toContain('part().tool === "question" && partMetadata()?.interrupted === true')
  expect(source).toContain('"ui.messagePart.questions.interrupted"')
})

test("interrupted i18n key exists in zh and en", () => {
  const zh = readFileSync(new URL("../i18n/zh.ts", import.meta.url), "utf8")
  const en = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8")

  expect(zh).toContain('"ui.messagePart.questions.interrupted":')
  expect(en).toContain('"ui.messagePart.questions.interrupted":')
})
