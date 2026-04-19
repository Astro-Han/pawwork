import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import path from "node:path"
import { createRendererWorkspaceConfig } from "./renderer-workspace-config"

test("renderer dev server allows the resolved workspace node_modules path", () => {
  const expected = realpathSync(path.resolve(import.meta.dir, "../../node_modules"))
  const allow = createRendererWorkspaceConfig(import.meta.dir).server.fs.allow

  expect(allow).toContain(expected)
})

test("renderer dedupes the ui workspace package", () => {
  const dedupe = createRendererWorkspaceConfig(import.meta.dir).resolve.dedupe

  expect(dedupe).toContain("@opencode-ai/ui")
})
