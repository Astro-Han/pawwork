import { createRequire } from "node:module"
import { describe, expect, test } from "vitest"
import { readProductPatch } from "./dsh-product-patch.testing"

const require = createRequire(import.meta.url)

function insertedHarnessPackages() {
  return readProductPatch()
    .flatMap((entry) => entry.insert ?? [])
    .map((row) => row.name)
    .filter((name) => name.startsWith("@deepseek-ai/"))
}

describe("PawWork DSH product mounts", () => {
  // A row the overlay inserts by bare name is resolved by the harness from the
  // DSH home, not from this package — so a name that is not a real installed
  // package fails at boot with `Cannot find package`, taking the whole app down,
  // and nothing before runtime says so. Resolving each one here is the check;
  // asserting version literals instead would only restate package.json and go
  // red on every routine bump.
  test("mounts only harness packages that are actually installed", () => {
    const mounted = insertedHarnessPackages()

    expect(mounted.length).toBeGreaterThan(0)
    for (const name of mounted) {
      expect(() => require.resolve(`${name}/package.json`)).not.toThrow()
    }
  })
})
