import { describe, expect, test } from "vitest"
import { readProductPatch } from "./dsh-product-patch.testing"

describe("PawWork DSH session search", () => {
  // The row exists only to displace two upstream values, so those two values are
  // what it guards — but a row that is absent displaces nothing while answering
  // every assertion about its config the same way an applied one does, so its
  // presence is asserted first. Both fields are validated by the engine at
  // construction, not against any schema this overlay is checked by, so a wrong
  // value is not something the product recovers from: it is `openAt is not
  // supported` or `path must not be blank` thrown on the launch path. `!!js`
  // rows arrive as source text, which is all a test can read; an expression
  // naming no real helper is equally fatal and equally invisible until boot.
  test("displaces the upstream values that make session search useless", () => {
    const row = readProductPatch().find((entry) => entry.id === "session-query-sqlite")

    expect(row).toBeDefined()
    // `:memory:` is dropped on exit, so the sidebar could only ever match titles.
    expect(row?.config?.path).toMatch(/^dshHomePath\('[^']+'\)$/)
    // `never` makes the engine refuse full-text calls outright, and `startup`
    // would make a user who never searches pay for opening SQLite anyway.
    expect(row?.config?.openAt).toBe("first-search")
  })
})
