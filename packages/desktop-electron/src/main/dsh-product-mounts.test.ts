import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import {
  allRows,
  overlaidRows,
  productPatchFile,
  readProductPatch,
} from "./dsh-product-patch.testing"

const require = createRequire(import.meta.url)

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
  // DSH home, not from this package — so a name that is not a real installed
  // package fails at boot with `Cannot find package`, taking the whole app down,
  // and nothing before runtime says so. Resolving each one here is the check;
  // asserting version literals instead would only restate package.json and go
  // red on every routine bump.
  test("mounts only harness packages that are actually installed", () => {
    const mounted = insertedNames().filter((name) => name.startsWith("@deepseek-ai/"))

    expect(mounted.length).toBeGreaterThan(0)
    for (const name of mounted) {
      expect(() => require.resolve(`${name}/package.json`)).not.toThrow()
    }
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

  // A patch replaces the targeted row's whole config, so this override owns
  // every key upstream's `web-runtime` row sets — including the two it does not
  // choose, one of which is a `!!js` expression reading the parsed CLI flags. A
  // key upstream adds later is dropped by this row without any warning, and the
  // only symptom is whatever it configured quietly reverting to its default.
  test("restates every web-runtime key upstream owns while silencing the URL line", () => {
    const ours = readProductPatch().find((entry) => entry.id === "web-runtime")?.config
    const upstream = overlaidRows().find((row) => row.id === "web-runtime")?.config

    expect(upstream).toBeDefined()
    expect({ ...ours, printUrl: undefined }).toEqual({ ...upstream, printUrl: undefined })
    // The window is handed this URL over IPC instead. Printing it writes the
    // launch token — the session's sole authentication input — to the
    // application log, which outlives the process whose port it unlocks.
    expect(upstream?.printUrl).toBe(true)
    expect(ours?.printUrl).toBe(false)
  })

  // `refreshIntervalMs` has no default upstream: the clock is injected once per
  // step unless a positive interval floors it, so losing this value does not
  // disable a feature, it quietly makes every step carry its own reading.
  test("floors the clock injections with a positive interval", () => {
    const clock = insertedRows().find((row) => row.name === "@deepseek-ai/dsh-time-context")

    expect(clock?.config?.refreshIntervalMs).toBeGreaterThan(0)
  })
})
