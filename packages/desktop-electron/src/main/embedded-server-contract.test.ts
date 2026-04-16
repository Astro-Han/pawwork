import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  embeddedServerArtifacts,
  embeddedServerMissingArtifacts,
  embeddedServerMissingArtifactsMessage,
} from "./embedded-server-contract"

test("embedded server contract points at the runtime bundle", () => {
  const opencodeRoot = path.join("/repo", "packages", "opencode")
  const runtimeDir = path.join(opencodeRoot, "dist", "node")

  expect(embeddedServerArtifacts(opencodeRoot)).toEqual({
    runtimeDir,
    runtimeEntry: path.join(runtimeDir, "node.js"),
    requiredWasmGlobs: [
      path.join(runtimeDir, "tree-sitter-*.wasm"),
      path.join(runtimeDir, "tree-sitter-bash-*.wasm"),
      path.join(runtimeDir, "tree-sitter-powershell-*.wasm"),
    ],
  })
})

test("missing artifact message tells the caller which prepare step to run", () => {
  const opencodeRoot = path.join("/repo", "packages", "opencode")
  const missing = embeddedServerMissingArtifacts(opencodeRoot, () => false)

  expect(missing).toEqual([
    path.join(opencodeRoot, "dist", "node", "node.js"),
    path.join(opencodeRoot, "dist", "node", "tree-sitter-*.wasm"),
    path.join(opencodeRoot, "dist", "node", "tree-sitter-bash-*.wasm"),
    path.join(opencodeRoot, "dist", "node", "tree-sitter-powershell-*.wasm"),
  ])
  expect(embeddedServerMissingArtifactsMessage(opencodeRoot, missing)).toContain(
    "bun ./scripts/prepare-embedded-server.ts",
  )
})

test("missing the base tree-sitter wasm still fails the contract", () => {
  const opencodeRoot = path.join(import.meta.dir, "..", "..", "..", "test-tmp", "embedded-server-contract")
  const runtimeDir = path.join(opencodeRoot, "dist", "node")
  fs.rmSync(opencodeRoot, { recursive: true, force: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, "node.js"), "")
  fs.writeFileSync(path.join(runtimeDir, "tree-sitter-bash-abc.wasm"), "")
  fs.writeFileSync(path.join(runtimeDir, "tree-sitter-powershell-def.wasm"), "")

  expect(embeddedServerMissingArtifacts(opencodeRoot, fs.existsSync)).toContain(
    path.join(runtimeDir, "tree-sitter-*.wasm"),
  )

  fs.rmSync(opencodeRoot, { recursive: true, force: true })
})
