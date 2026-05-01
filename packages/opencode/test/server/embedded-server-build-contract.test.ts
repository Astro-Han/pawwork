import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"
import { expectModelsSnapshotUnchanged, writeCurrentModelsFixture } from "./models-snapshot-fixture"

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
    await using tmp = await tmpdir()
    const modelsFixture = writeCurrentModelsFixture(root, tmp.path)

    await Process.run([process.execPath, "run", "build:embedded-server"], {
      cwd: root,
      env: { MODELS_DEV_API_JSON: modelsFixture.fixture },
    })

    expect(fs.existsSync(runtimeEntry)).toBe(true)
    const files = fs.readdirSync(runtimeDir)

    for (const matches of requiredWasmMatchers) {
      expect(files.some((file) => matches(file))).toBe(true)
    }
    expectModelsSnapshotUnchanged(modelsFixture)
  })
}, 120_000)
