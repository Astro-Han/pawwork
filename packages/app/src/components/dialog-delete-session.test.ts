import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./dialog-delete-session.tsx", import.meta.url), "utf8")

describe("DialogDeleteSession source contract", () => {
  test("does not depend on SyncProvider context", () => {
    expect(source).not.toContain("@/context/sync")
    expect(source).not.toContain("useSync(")
    expect(source).not.toContain("@/context/sdk")
    expect(source).not.toContain("useSDK(")
  })

  test("receives the session name from its caller", () => {
    expect(source).toContain("name: string")
    expect(source).toContain("props.name")
  })
})
