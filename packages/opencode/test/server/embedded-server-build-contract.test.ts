import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Process } from "../../src/util/process"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"

const root = path.join(import.meta.dir, "../..")
const runtimeDir = path.join(root, "dist", "node")
const runtimeEntry = path.join(runtimeDir, "node.js")
const requiredWasmMatchers = [
  (file: string) => /^tree-sitter-[^-]+\.wasm$/.test(file),
  (file: string) => /^tree-sitter-bash-.+\.wasm$/.test(file),
  (file: string) => /^tree-sitter-powershell-.+\.wasm$/.test(file),
]

test("build:embedded-server emits the runtime entrypoint and wasm sidecars", async () => {
  await withEmbeddedServerArtifactLock(async () => {
    await Process.run([process.execPath, "run", "build:embedded-server"], {
      cwd: root,
    })

    expect(fs.existsSync(runtimeEntry)).toBe(true)
    const files = fs.readdirSync(runtimeDir)

    for (const matches of requiredWasmMatchers) {
      expect(files.some((file) => matches(file))).toBe(true)
    }
  })
}, 120_000)
