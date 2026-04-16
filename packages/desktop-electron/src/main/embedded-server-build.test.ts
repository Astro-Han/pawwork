import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { withEmbeddedServerArtifactLock } from "../../../opencode/test/shared/embedded-server-artifact-lock"

const root = path.join(import.meta.dir, "../..")
const runtimeDir = path.resolve(root, "../opencode/dist/node")
const outDir = path.join(root, "out")
const outChunksDir = path.join(outDir, "main", "chunks")
const electronViteBin = path.join(root, "node_modules", ".bin", "electron-vite")
const requiredWasmMatchers = [
  (file: string) => /^tree-sitter-[^-]+\.wasm$/.test(file),
  (file: string) => /^tree-sitter-bash-.+\.wasm$/.test(file),
  (file: string) => /^tree-sitter-powershell-.+\.wasm$/.test(file),
]

function run(cmd: string[]) {
  const result = Bun.spawnSync({
    cmd,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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
    fs.rmSync(runtimeDir, { recursive: true, force: true })
    fs.rmSync(outDir, { recursive: true, force: true })

    run([process.execPath, "./scripts/prepare-embedded-server.ts"])
    run([electronViteBin, "build"])

    const files = fs.readdirSync(outChunksDir)

    for (const matches of requiredWasmMatchers) {
      expect(files.some((file) => matches(file))).toBe(true)
    }
  })
}, 120_000)
