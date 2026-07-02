// Builds cdp-bridge-ws-harness.ts with "ws" kept external and runs it under
// real Node, where "ws" resolves to the real ws@8.20.0 — the same pairing as
// the production Electron main process. bun test cannot exercise ws frame-level
// protocol errors because bun resolves "ws" to its own native shim.
import { join } from "node:path"

const packageRoot = join(import.meta.dir, "..")
const outdir = join(packageRoot, ".artifacts", "ws-smoke")

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "cdp-bridge-ws-harness.ts")],
  target: "node",
  external: ["ws", "electron"],
  outdir,
  naming: "[name].mjs",
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}

// The bundle sits under packages/desktop-electron, so Node resolves "ws" from
// this package's node_modules — the real library, not a shim.
const harness = Bun.spawn(["node", join(outdir, "cdp-bridge-ws-harness.mjs")], {
  cwd: packageRoot,
  stdout: "pipe",
  stderr: "pipe",
})
const exitCode = await harness.exited
const stdout = await new Response(harness.stdout).text()
const stderr = await new Response(harness.stderr).text()

if (exitCode !== 0 || !stdout.includes("SMOKE-OK")) {
  console.error(stdout + stderr)
  console.error(`cdp-bridge ws smoke failed (exit ${exitCode})`)
  process.exit(1)
}
console.log(stdout.trim())
