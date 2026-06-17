import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

function runGuard(version) {
  return spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      [
        `Object.defineProperty(process, "version", { value: ${JSON.stringify(version)} })`,
        `await import("./check-node.mjs")`,
      ].join(";"),
    ],
    {
      cwd: import.meta.dirname,
      encoding: "utf8",
    },
  )
}

test("allows Node 24", () => {
  const result = runGuard("v24.14.0")

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
})

test("allows Node 26", () => {
  const result = runGuard("v26.3.0")

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
})

test("rejects unparseable Node versions with a clean message", () => {
  const result = runGuard("invalid-version")

  expect(result.status).toBe(1)
  expect(result.stderr).toContain("Unsupported Node version format: invalid-version")
})
