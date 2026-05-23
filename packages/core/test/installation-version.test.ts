import path from "path"
import { expect, test } from "bun:test"

const cwd = path.resolve(import.meta.dir, "..")
const decode = (input: { toString(): string } | undefined) => input?.toString() ?? ""

function runVersionImport(defines: string[]) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      ...defines.flatMap((value) => ["--define", value]),
      "-e",
      'import("./src/installation/version.ts").then((mod) => console.log(mod.InstallationPluginVersion))',
    ],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
}

test("fails packaged builds when the plugin version define is missing", () => {
  const result = runVersionImport(['OPENCODE_CHANNEL="prod"', 'OPENCODE_VERSION="0.0.0-prod-202605230200"'])

  expect(result.exitCode).not.toBe(0)
  expect(decode(result.stderr)).toContain("OPENCODE_PLUGIN_VERSION")
})

test("uses the injected plugin version for packaged builds", () => {
  const result = runVersionImport([
    'OPENCODE_CHANNEL="prod"',
    'OPENCODE_VERSION="0.0.0-prod-202605230200"',
    'OPENCODE_PLUGIN_VERSION="1.14.19"',
  ])

  expect(result.exitCode).toBe(0)
  expect(decode(result.stdout).trim()).toBe("1.14.19")
})
