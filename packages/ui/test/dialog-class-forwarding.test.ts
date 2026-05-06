/**
 * Dialog primitive — class/classList forwarding contract.
 * Slice 07, issue #440.
 *
 * The previous implementation merged props.class into a classList object as
 * a key: `classList={{ [props.class ?? ""]: !!props.class }}`. When callers
 * pass a multi-token string (e.g. "w-full max-w-[420px] mx-auto"), the
 * native DOMTokenList.toggle path would throw on whitespace in the token.
 * SolidJS's classList runtime in fact pre-trims+splits keys, so the old
 * code did not actually crash, but the inline form is the convention this
 * codebase prefers (Sheet was already migrated).
 *
 * This test pins both halves of the evidence so future refactors don't
 * silently regress to the old form:
 *   1. dialog.tsx forwards props.class via `class={...}`, not as a key
 *      inside a classList object.
 *   2. Sheet uses the same pattern.
 *   3. The SolidJS runtime really does trim+split classList keys (so the
 *      legacy form would also have been safe, but only as long as that
 *      runtime invariant holds).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const DIALOG_TSX = readFileSync(join(ROOT, "src/components/dialog.tsx"), "utf-8")
const SHEET_TSX = readFileSync(join(ROOT, "src/components/sheet.tsx"), "utf-8")

describe("Dialog — class/classList forwarding", () => {
  test("forwards props.class via class={...}, not as classList key", () => {
    expect(DIALOG_TSX).toMatch(/class=\{props\.class\}/)
    expect(DIALOG_TSX).toMatch(/classList=\{props\.classList\}/)
  })

  test("does not merge props.class into classList object as key (regression guard)", () => {
    expect(DIALOG_TSX).not.toMatch(/\[props\.class\s*\?\?\s*""\]\s*:\s*!!props\.class/)
  })
})

describe("Sheet — class/classList forwarding (same pattern as Dialog)", () => {
  test("forwards props.class via class={...}", () => {
    expect(SHEET_TSX).toMatch(/class=\{props\.class\}/)
    expect(SHEET_TSX).toMatch(/classList=\{props\.classList\}/)
  })

  test("does not merge props.class into classList object as key", () => {
    expect(SHEET_TSX).not.toMatch(/\[props\.class\s*\?\?\s*""\]\s*:\s*!!props\.class/)
  })
})

describe("SolidJS runtime — toggleClassKey trims + splits multi-token keys", () => {
  // Backstop: even if a future caller regresses to the legacy classList-key
  // form, the SolidJS runtime currently neutralizes whitespace tokens.
  // If this assertion ever fails, the legacy form becomes a real crash
  // hazard and we should hard-ban it via lint, not just convention.
  test("solid-js/web client bundle contains trim+split for classList keys", () => {
    // require.resolve picks the server bundle under bun's default conditions;
    // sibling client bundle is `web.js` in the same dist/ dir. A solid-js
    // version bump that moves either file will fail this test and force a
    // maintainer to re-verify the runtime invariant.
    const serverPath = require.resolve("solid-js/web")
    // sibling client bundle: server.{js,cjs,mjs} → web.{js,cjs,mjs}
    const clientPath = serverPath.replace(/\/server\.(js|cjs|mjs)$/, "/web.$1")
    expect(clientPath).not.toBe(serverPath) // sanity: replacement happened
    const src = readFileSync(clientPath, "utf-8")
    expect(src).toMatch(/key\.trim\(\)\.split\(\/\\s\+\/\)/)
  })
})
