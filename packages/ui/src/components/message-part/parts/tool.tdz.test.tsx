import { expect, test, describe } from "bun:test"
import { readFileSync } from "node:fs"

// Regression lock for the TDZ fixed in commit e327368ec.
//
// Before the fix, `const hideQuestion = createMemo(...)` was declared
// BEFORE `const partMetadata = () => ...`. Solid's `createMemo` runs the
// callback eagerly at component init; for a running question the callback
// reached `newQuestionPath() -> partMetadata()` while the `partMetadata`
// binding was still in its temporal dead zone, throwing ReferenceError
// at mount.
//
// We assert source ordering directly: `partMetadata` MUST be declared
// before any function-expression body that closes over it is created
// alongside the eager `createMemo` call. The runtime check would require
// a full browser-conditions render (happydom alone is not enough — Solid
// resolves to its server build and any router-touching component path
// throws notSup). Source-text assertion matches the existing ui-package
// test convention (see button-states.test.ts, undefined-tokens.test.ts)
// and is mechanically sufficient to catch the regression: anyone who
// reorders `partMetadata` back below the memo will flunk this test.

const src = readFileSync(new URL("./tool.tsx", import.meta.url), "utf8")

const indexOfDecl = (needle: string): number => {
  const idx = src.indexOf(needle)
  if (idx < 0) throw new Error(`expected to find ${JSON.stringify(needle)} in tool.tsx`)
  return idx
}

describe("ToolPartDisplay TDZ regression (e327368ec)", () => {
  test("partMetadata is declared before newQuestionPath references it", () => {
    const partMetadataIdx = indexOfDecl("const partMetadata =")
    const newQuestionPathIdx = indexOfDecl("const newQuestionPath =")
    expect(partMetadataIdx).toBeLessThan(newQuestionPathIdx)
  })

  test("partMetadata is declared before the eager createMemo call", () => {
    const partMetadataIdx = indexOfDecl("const partMetadata =")
    const hideQuestionIdx = indexOfDecl("const hideQuestion = createMemo")
    expect(partMetadataIdx).toBeLessThan(hideQuestionIdx)
  })

  test("hideQuestion still uses createMemo (eager-evaluation contract)", () => {
    // If someone replaces createMemo with a plain getter, the TDZ risk
    // disappears but so does the memoization. Lock the primitive.
    expect(src).toContain("const hideQuestion = createMemo(")
  })
})
