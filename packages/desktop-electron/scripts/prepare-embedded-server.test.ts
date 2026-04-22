import { expect, test } from "bun:test"
import path from "node:path"
import { resolveOpencodeRoot } from "./embedded-server-path"

test("prepare-embedded-server resolves the opencode workspace from the script directory", () => {
  const scriptDir = path.join("/repo", "packages", "desktop-electron", "scripts")
  expect(resolveOpencodeRoot(scriptDir)).toBe(path.resolve(scriptDir, "../../opencode"))
})
