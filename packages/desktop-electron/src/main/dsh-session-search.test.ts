import { describe, expect, test } from "vitest"
import { readProductPatch } from "./dsh-product-patch.testing"

describe("PawWork DSH session search", () => {
  // The row exists only to displace two upstream values, so those two values are
  // what it guards. Asserting the replacements instead would just read the YAML
  // back to itself; naming what must NOT be there survives a rewording of what is.
  test("displaces the upstream values that make session search useless", () => {
    const config = readProductPatch().find((entry) => entry.id === "session-query-sqlite")?.config

    // `:memory:` is dropped on exit, so the sidebar could only ever match titles.
    expect(config?.path).not.toBe(":memory:")
    // `never` makes the engine refuse full-text calls outright.
    expect(config?.openAt).not.toBe("never")
    // …and `startup` would make a user who never searches pay for SQLite anyway.
    expect(config?.openAt).not.toBe("startup")
  })
})
