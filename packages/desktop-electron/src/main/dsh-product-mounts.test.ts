import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { resolveDshHome } from "./pawwork-home"
import { type EntryRow, productPatchFile, readProductPatch } from "./dsh-product-patch.testing"

const require = createRequire(import.meta.url)

// Every inserted row at any depth: an insert list may itself carry inserts, and
// a row that only these checks would have caught is exactly the row nobody
// notices is unchecked.
function insertedRows(rows: EntryRow[] = readProductPatch()): EntryRow[] {
  return rows.flatMap((row) => [...(row.insert ?? []), ...insertedRows(row.insert ?? [])])
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

  // The user-global instruction file belongs to PawWork, not to one channel's
  // harness home: a user who writes ~/.pawwork/AGENTS.md expects both the dev
  // and prod builds to read it. dsh-base defaults `dshHome` to the running
  // harness home, which would scope the file to ~/.pawwork/dsh (or dsh-dev), so
  // this overlay lifts it one level. Upstream joins the value with AGENTS.md
  // directly, so a rename of this config key moves the file with no error.
  test("keeps the user-global AGENTS.md at the PawWork home root", () => {
    const home = "/home/example"
    const instructions = readProductPatch().find((entry) => entry.id === "agent-instructions")

    expect(instructions?.config?.dshHome).toBe("~/.pawwork")
    expect(dirname(resolveDshHome({ channel: "prod", homeRoot: home }))).toBe(`${home}/.pawwork`)
    expect(dirname(resolveDshHome({ channel: "dev", homeRoot: home }))).toBe(`${home}/.pawwork`)
  })

  // `refreshIntervalMs` has no default upstream: the clock is injected once per
  // step unless a positive interval floors it, so losing this value does not
  // disable a feature, it quietly makes every step carry its own reading.
  test("floors the clock injections with a positive interval", () => {
    const clock = insertedRows().find((row) => row.name === "@deepseek-ai/dsh-time-context")

    expect(clock?.config?.refreshIntervalMs).toBeGreaterThan(0)
  })
})
