import { expect, test } from "bun:test"

import { checkNodeVersion } from "./check-node.mjs"

test("rejects Node 25+ with reinstall guidance", () => {
  const result = checkNodeVersion("v26.3.0")

  expect(result.ok).toBe(false)
  expect(result.message).toContain("Current node: v26.3.0")
  expect(result.message).toContain("Node 24")
  expect(result.message).toContain(".node-version")
  expect(result.message).toContain("rm -rf node_modules")
  expect(result.message).toContain("bun install --frozen-lockfile")
})

test("allows Node 24", () => {
  expect(checkNodeVersion("v24.14.0")).toEqual({ ok: true })
})
