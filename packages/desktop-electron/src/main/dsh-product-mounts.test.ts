import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import {
  allRows,
  overlaidRows,
  productPatchFile,
  productionClosure,
  readProductPatch,
} from "./dsh-product-patch.testing"

/** Every row the overlay inserts, at any depth. */
function insertedRows() {
  return allRows(readProductPatch().flatMap((entry) => entry.insert ?? []))
}

/** Every inserted row's entry name; a row that states none mounts nothing. */
function insertedNames() {
  return insertedRows().flatMap((row) => (row.name === undefined ? [] : [row.name]))
}

describe("PawWork DSH product mounts", () => {
  // A row the overlay inserts by bare name is resolved by the harness from the
  // DSH home, not from this package — so a name that is not there at runtime
  // fails at boot with `Cannot find package`, taking the whole app down, and
  // nothing before runtime says so.
  //
  // Membership in the production closure rather than `require.resolve`, which
  // answers a weaker question than it looks like it does: under vitest it also
  // searches pnpm's hidden hoist directory, which holds the whole store, so a
  // dev-only package — one electron-builder prunes — resolves here and is
  // missing from the packaged app. Asserting version literals instead would
  // only restate package.json and go red on every routine bump.
  test("mounts only harness packages the packaged app will actually have", () => {
    const closure = productionClosure()
    const mounted = insertedNames().filter((name) => name.startsWith("@deepseek-ai/"))

    expect(mounted.length).toBeGreaterThan(0)
    for (const name of mounted) expect([name, closure.has(name)]).toEqual([name, true])
  })

  // A relative name resolves against the directory of the patch file stating it.
  // That base moved in 0.1.2-alpha.2 — it was the active profile directory — and
  // the move broke this overlay's one relative row with a runtime `Cannot find
  // module`, the same silent-until-boot failure as a bad package name.
  test("mounts only relative entries that exist beside the overlay", () => {
    const relative = insertedNames().filter((name) => name.startsWith("./") || name.startsWith("../"))

    expect(relative.length).toBeGreaterThan(0)
    for (const name of relative) {
      expect(existsSync(resolve(dirname(productPatchFile), name))).toBe(true)
    }
  })

  // The id is the handle every later patch and every settings namespace uses to
  // address a row. Two rows sharing one, or a row whose id is a typo of the
  // intended one, both compose without complaint — the id simply addresses
  // something other than what was meant, or nothing at all.
  test("gives every inserted row a distinct id", () => {
    const ids = insertedRows().map((row) => row.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  // A patch replaces the targeted row's whole config, so this override owns all
  // four keys upstream's `web-runtime` row sets, though it chooses only one of
  // them — and two of the three it restates are `!!js` expressions reading the
  // parsed CLI flags. A key upstream adds later is dropped by this row without
  // any warning, and the only symptom is whatever it configured quietly
  // reverting to its default. `pawwork-web-ready` is what reports the URL
  // instead; see resources/dsh/product/lib/web-ready.js for why.
  test("restates every web-runtime key upstream owns while silencing the URL line", () => {
    const ours = readProductPatch().find((entry) => entry.id === "web-runtime")?.config
    const upstream = overlaidRows().findLast((row) => row.id === "web-runtime")?.config

    expect(upstream).toBeDefined()
    expect({ ...ours, printUrl: undefined }).toEqual({ ...upstream, printUrl: undefined })
    expect(upstream?.printUrl).toBe(true)
    expect(ours?.printUrl).toBe(false)
  })

  // A patch row whose id upstream renamed composes without complaint and
  // addresses nothing, which would leave the model without a clock.
  test("turns on the clock dsh-web-app ships disabled", () => {
    const rows = [...overlaidRows(), ...allRows(readProductPatch())].filter((row) => row.id === "time-context")
    const disabled = rows.reduce<boolean | undefined>((state, row) => row.disabled ?? state, undefined)

    expect(rows.map((row) => row.name)).toContain("@deepseek-ai/dsh-time-context")
    expect(disabled).toBe(false)
  })
})
