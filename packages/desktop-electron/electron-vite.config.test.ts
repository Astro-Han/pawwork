import { expect, test } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
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

test("main build does not externalize OpenCLI from the desktop bundle", () => {
  const source = readFileSync(path.join(import.meta.dir, "electron.vite.config.ts"), "utf8")

  // node-pty is the only dependency force-externalized (a native module); OpenCLI
  // stays bundled. remote-bridge ships .ts source, so it is force-BUNDLED via
  // exclude — leaving it external would leak a bare .ts import the runtime guard
  // rejects (see desktop-smoke).
  expect(source).toContain("include: [nodePtyPkg]")
  expect(source).toContain('exclude: ["@opencode-ai/remote-bridge"]')
  expect(source).not.toContain("OPENCLI_EXTERNALS")
})
