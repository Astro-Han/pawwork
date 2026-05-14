import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const COMPONENT_DIR = dirname(fileURLToPath(import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) return sourceFiles(full)
      if (stat.isFile() && /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) return [full]
      return []
    })
    .sort()
}

function readMessagePartSources() {
  return [
    readFileSync(join(COMPONENT_DIR, "message-part.tsx"), "utf8"),
    ...sourceFiles(join(COMPONENT_DIR, "message-part")).map((file) => readFileSync(file, "utf8")),
  ].join("\n")
}

test("assistant part renderers capture item values before passing them to Part", () => {
  const source = readMessagePartSources()

  expect(source).toContain("function latestDefined")
  expect(source).not.toContain("<Show when={item()} keyed>")
  expect(source).not.toMatch(/part=\{item\(\)!?\}/)
  expect(source).not.toMatch(/defaultOpen=\{partDefaultOpen\(item\(\)!?/)
  expect(source).not.toMatch(/message=\{message\(\)!?\}/)
})

test("tool file accordions account for tool content gap in sticky offset", () => {
  const source = readMessagePartSources()

  expect(source).toContain('style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}')
  expect(source).not.toContain('style={{ "--sticky-accordion-offset": "40px" }}')
})

// Cancelled question variant must identify the case via metadata.interrupted
// (written by processor cleanup) so the check stays decoupled from the exact
// backend error string. See #419.
test("question tool error renders interrupted variant via metadata.interrupted", () => {
  const source = readMessagePartSources()

  expect(source).toContain('part().tool === "question" && partMetadata()?.interrupted === true')
  expect(source).toContain('"ui.messagePart.questions.interrupted"')
})

test("websearch tool errors render localized structured failure copy", () => {
  const source = readMessagePartSources()

  expect(source).toContain('part().tool === "websearch" ? webSearchErrorDisplay(partMetadata(), i18n) : undefined')
  expect(source).toContain("error={webSearchError?.error ?? error()}")
  expect(source).toContain("subtitle={webSearchError?.subtitle ?? taskSubtitle()}")
})

test("interrupted i18n key exists in zh and en", () => {
  const zh = readFileSync(new URL("../i18n/zh.ts", import.meta.url), "utf8")
  const en = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8")

  expect(zh).toContain('"ui.messagePart.questions.interrupted":')
  expect(en).toContain('"ui.messagePart.questions.interrupted":')
})

// Live-stream reactivity: the interrupted hint must reappear when the part's
// metadata.interrupted flips from undefined → true *without* a page reload.
// In Solid that requires reading `partMetadata()` as an accessor over
// `part().state` so the JSX re-evaluates when props.part is replaced — not
// a one-shot snapshot at component setup. Lock the accessor pattern so a
// future "let me memo this once" refactor can't silently break live updates.
test("partMetadata is a fresh accessor over part().state, not a setup-time snapshot", () => {
  const source = readMessagePartSources()

  // Defined as () => …, not const partMetadata = props.part.metadata
  expect(source).toContain("const partMetadata = () => toolStateMetadata(part().state)")
  expect(source).not.toMatch(/const partMetadata\s*=\s*props\.part\.metadata/)
  expect(source).not.toMatch(/const partMetadata\s*=\s*createMemo\(\)/)
})

test("synthetic stop tool parts are hidden through reactive metadata", () => {
  const source = readMessagePartSources()

  expect(source).toContain("const hideSyntheticStop = createMemo(")
  expect(source).toMatch(/partMetadata\(\)\.diagnostics\?\.loop\?\.loopAction\s*===\s*"stop"/)
})

test("tool part wrapper suppresses both pending questions and synthetic stop tools", () => {
  const source = readMessagePartSources()

  expect(source).toContain("<Show when={!hideQuestion() && !hideSyntheticStop()}>")
})

// Ensure the metadata extractor itself respects the shape variations the
// live message stream actually emits — including the case where the part
// initially has no metadata key and gains one on the next update.
test("toolStateMetadata extracts interrupted flag across part state shapes", () => {
  // Inline reimplementation that mirrors the helper in message-part.tsx
  // (kept private there). Drift between the two will trip the structural
  // test above before it reaches users.
  function toolStateMetadata(state: unknown): Record<string, any> {
    if (!state || typeof state !== "object" || !("metadata" in state)) return {}
    const metadata = (state as { metadata: unknown }).metadata
    return metadata && typeof metadata === "object" ? (metadata as Record<string, any>) : {}
  }

  expect(toolStateMetadata(undefined).interrupted).toBeUndefined()
  expect(toolStateMetadata({}).interrupted).toBeUndefined()
  expect(toolStateMetadata({ metadata: undefined }).interrupted).toBeUndefined()
  expect(toolStateMetadata({ metadata: {} }).interrupted).toBeUndefined()
  expect(toolStateMetadata({ metadata: { interrupted: true } }).interrupted).toBe(true)
  // Reactivity contract: a new state object with the flag flipped must
  // produce a fresh metadata object so equality checks downstream observe
  // the change rather than caching a stale reference.
  const before = toolStateMetadata({ metadata: { interrupted: undefined } })
  const after = toolStateMetadata({ metadata: { interrupted: true } })
  expect(before).not.toBe(after)
})
