import { describe, expect, test } from "bun:test"
import path from "path"
import { isSensitivePath, isSensitiveTargetPath, sensitivityPath } from "../../src/tool/sensitive"

describe("tool sensitive path helpers", () => {
  test("classifies project files from paths relative to the project root", () => {
    const root = path.join(path.sep, "tmp", "secret-service")

    expect(isSensitivePath(sensitivityPath(path.join(root, "src", "app.ts"), root))).toBe(false)
    expect(isSensitivePath(sensitivityPath(path.join(root, ".env"), root))).toBe(true)
  })

  test("classifies external files from their basename and explicit sensitive directories", () => {
    const root = path.join(path.sep, "tmp", "project")

    expect(isSensitiveTargetPath(path.join(path.sep, "tmp", "token-tests", "app.ts"), root)).toBe(false)
    expect(isSensitiveTargetPath(path.join(path.sep, "tmp", "token-tests", ".env"), root)).toBe(true)
    expect(isSensitiveTargetPath(path.join(path.sep, "tmp", "credentials", "config.json"), root)).toBe(true)
    expect(isSensitiveTargetPath(path.join(path.sep, "tmp", "my-secrets", "config.json"), root)).toBe(true)
    expect(isSensitiveTargetPath(path.join(path.sep, "tmp", "prod_credentials", "config.json"), root)).toBe(true)
    expect(isSensitiveTargetPath(path.join(path.sep, "tmp", "private-key-backup", "config.json"), root)).toBe(true)
  })
})
