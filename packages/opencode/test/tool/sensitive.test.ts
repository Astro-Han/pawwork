import { describe, expect, test } from "bun:test"
import path from "path"
import { isSensitivePath, sensitivityPath } from "../../src/tool/sensitive"

describe("tool sensitive path helpers", () => {
  test("classifies project files from paths relative to the project root", () => {
    const root = path.join(path.sep, "tmp", "secret-service")

    expect(isSensitivePath(sensitivityPath(path.join(root, "src", "app.ts"), root))).toBe(false)
    expect(isSensitivePath(sensitivityPath(path.join(root, ".env"), root))).toBe(true)
  })

  test("classifies external files from their basename only", () => {
    const root = path.join(path.sep, "tmp", "project")

    expect(isSensitivePath(sensitivityPath(path.join(path.sep, "tmp", "token-tests", "app.ts"), root))).toBe(false)
    expect(isSensitivePath(sensitivityPath(path.join(path.sep, "tmp", "token-tests", ".env"), root))).toBe(true)
  })
})
