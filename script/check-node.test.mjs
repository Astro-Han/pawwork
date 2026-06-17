import { expect, test } from "bun:test"

import { checkNodeVersion } from "./check-node.mjs"

test("rejects Node 25+ with reinstall guidance", () => {
  const result = checkNodeVersion("v25.0.0")

  expect(result.ok).toBe(false)
  expect(result.message).toContain("Current node: v25.0.0")
  expect(result.message).toContain("Node 24")
  expect(result.message).toContain(".node-version")
  expect(result.message).toContain("delete node_modules")
  expect(result.message).toContain("rm -rf node_modules")
  expect(result.message).toContain("Remove-Item -Recurse -Force node_modules")
  expect(result.message).toContain("bun install --frozen-lockfile")
})

test("allows Node 24", () => {
  expect(checkNodeVersion("v24.14.0")).toEqual({ ok: true })
})

test("rejects unparseable Node versions with a clean message", () => {
  const result = checkNodeVersion("invalid-version")

  expect(result.ok).toBe(false)
  expect(result.message).toContain("Unsupported Node version format: invalid-version")
})
