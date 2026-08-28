import { createRequire } from "node:module"
import { describe, expect, test } from "vitest"
import { readProductPatch } from "./dsh-product-patch.testing"

const require = createRequire(import.meta.url)

function insertedRows() {
  return readProductPatch().flatMap((entry) => entry.insert ?? [])
}

describe("PawWork DSH product mounts", () => {
  // A row the overlay inserts by bare name is resolved by the harness from the
  // DSH home, not from this package — so a name that is not a real installed
  // package fails at boot with `Cannot find package`, taking the whole app down,
  // and nothing before runtime says so. Resolving each one here is the check;
  // asserting version literals instead would only restate package.json and go
  // red on every routine bump.
  test("mounts only harness packages that are actually installed", () => {
    const mounted = insertedRows()
      .map((row) => row.name)
      .filter((name) => name.startsWith("@deepseek-ai/"))

    expect(mounted.length).toBeGreaterThan(0)
    for (const name of mounted) {
      expect(() => require.resolve(`${name}/package.json`)).not.toThrow()
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

  // `refreshIntervalMs` has no default upstream: the clock is injected once per
  // step unless a positive interval floors it, so losing this value does not
  // disable a feature, it quietly makes every step carry its own reading.
  test("floors the clock injections with a positive interval", () => {
    const clock = insertedRows().find((row) => row.name === "@deepseek-ai/dsh-time-context")

    expect(clock?.config?.refreshIntervalMs).toBeGreaterThan(0)
  })
})
