import { spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, "..")
const snapDir = path.join(appDir, "e2e", "snap")

async function listTargets(): Promise<string[]> {
  const entries = await fs.readdir(snapDir).catch(() => [])
  return entries
    .filter((f) => f.endsWith(".snap.ts"))
    .map((f) => f.replace(/\.snap\.ts$/, ""))
    .sort()
}

async function fail(msg: string): Promise<never> {
  process.stderr.write(`[snap] ${msg}\n`)
  const targets = await listTargets()
  if (targets.length) {
    process.stderr.write(`[snap] available targets: ${targets.join(", ")}\n`)
  }
  process.stderr.write("[snap] usage: bun run snap <target>\n")
  process.exit(1)
}

const target = process.argv[2]
if (!target) await fail("missing target")

// Single source of truth: target must be a file under e2e/snap/. This catches
// case mismatches, path traversal, and typos in one check with one message.
const targets = await listTargets()
if (!targets.includes(target!)) await fail(`no such target: ${target}`)

const specRel = path.join("e2e", "snap", `${target}.snap.ts`)

const port = process.env.PLAYWRIGHT_PORT ?? "3000"

// No backend probe: the snap fixture spawns its own per-worker opencode via
// startBackend() (e2e/backend.ts), so snap is self-contained and doesn't
// require dev:desktop or any pre-running server.
const env = {
  ...process.env,
  PLAYWRIGHT_SNAP: "1",
  PLAYWRIGHT_WEB_COMMAND:
    process.env.PLAYWRIGHT_WEB_COMMAND ??
    `bun --cwd "${appDir}" dev -- --host 127.0.0.1 --port ${port}`,
}

const result = spawnSync(
  "bun",
  ["x", "playwright", "test", specRel, "--project=chromium", "--workers=1", "--reporter=line"],
  { stdio: "inherit", cwd: appDir, env },
)

if (result.error) {
  process.stderr.write(`[snap] failed to launch playwright: ${result.error.message}\n`)
}
process.exit(result.status ?? 1)
