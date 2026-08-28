import { describe, expect, test } from "vitest"
import { readProductPatch } from "./dsh-product-patch.testing"

/** `openAt` values the engine accepts; anything else throws at boot. */
const OPEN_AT = ["startup", "first-search", "never"]

describe("PawWork DSH session search", () => {
  // The row exists only to displace two upstream values, so those two values are
  // what it guards. But a row that is absent displaces nothing while answering
  // every "is not" the same way an applied one does, so its presence is asserted
  // before anything is asked about its contents.
  test("displaces the upstream values that make session search useless", () => {
    const row = readProductPatch().find((entry) => entry.id === "session-query-sqlite")

    expect(row).toBeDefined()
    // `:memory:` is dropped on exit, so the sidebar could only ever match titles.
    expect(row?.config?.path).not.toBe(":memory:")
    // `never` makes the engine refuse full-text calls outright, and `startup`
    // would make a user who never searches pay for SQLite anyway.
    expect(row?.config?.openAt).toBe("first-search")
  })

  // Both fields are validated by the engine at construction rather than by a
  // schema the overlay is checked against, so a typo here is not a wrong value
  // the product recovers from — it is `openAt is not supported` or `path must
  // not be blank` thrown on the launch path. `!!js` rows arrive as their source
  // text, which is the only thing a test can read; an expression that names no
  // real helper is equally fatal and equally invisible until boot.
  test("names values and a helper the engine will accept", () => {
    const config = readProductPatch().find((entry) => entry.id === "session-query-sqlite")?.config

    expect(OPEN_AT).toContain(config?.openAt)
    expect(config?.path).toMatch(/^dshHomePath\('[^']+'\)$/)
  })
})
