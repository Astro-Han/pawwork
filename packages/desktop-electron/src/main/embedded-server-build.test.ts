import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { withEmbeddedServerArtifactLock } from "../../../opencode/test/shared/embedded-server-artifact-lock"
import { tmpdir } from "../../../opencode/test/fixture/fixture"
import { expectModelsSnapshotUnchanged, writeCurrentModelsFixture } from "../../../opencode/test/server/models-snapshot-fixture"

const root = path.join(import.meta.dir, "../..")
const opencodeRoot = path.resolve(root, "../opencode")
const runtimeDir = path.resolve(root, "../opencode/dist/node")
const outDir = path.join(root, "out")
const outChunksDir = path.join(outDir, "main", "chunks")
const electronViteBin = path.join(root, "node_modules", ".bin", "electron-vite")
const requiredWasmMatchers = [
  (file: string) => /^tree-sitter-[^-]+\.wasm$/.test(file),
  (file: string) => /^tree-sitter-bash-.+\.wasm$/.test(file),
  (file: string) => /^tree-sitter-powershell-.+\.wasm$/.test(file),
]

function run(
  cmd: string[],
  options?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  },
) {
  const result = Bun.spawnSync({
    cmd,
    cwd: options?.cwd ?? root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options?.env },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${cmd.join(" ")}`,
        Buffer.from(result.stdout).toString(),
        Buffer.from(result.stderr).toString(),
      ].join("\n"),
    )
  }
}

test("electron-vite build copies required embedded server wasm sidecars into out/main/chunks", () => {
  return withEmbeddedServerArtifactLock(async () => {
    await using tmp = await tmpdir()
    const modelsFixture = writeCurrentModelsFixture(opencodeRoot, tmp.path)

    fs.rmSync(runtimeDir, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })

    run([process.execPath, "run", "build:embedded-server"], {
      cwd: opencodeRoot,
      env: { MODELS_DEV_API_JSON: modelsFixture.fixture },
    })
    run([electronViteBin, "build"])

    const files = fs.readdirSync(outChunksDir)

    for (const matches of requiredWasmMatchers) {
      expect(files.some((file) => matches(file))).toBe(true)
    }
    expect(fs.existsSync(path.join(outChunksDir, "node_modules", "@jackwener", "opencli", "cli-manifest.json"))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(outChunksDir, "node_modules", "@mixmark-io", "domino", "package.json"))).toBe(true)

    expectModelsSnapshotUnchanged(modelsFixture)
  })
}, 120_000)
