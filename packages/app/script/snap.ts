import { spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

const target = process.argv[2]
if (!target) {
  process.stderr.write("usage: bun run snap <target>\n")
  process.stderr.write("  target: name of e2e/snap/<target>.snap.ts (e.g. sidebar)\n")
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, "..")
const specRel = path.join("e2e", "snap", `${target}.snap.ts`)
const specAbs = path.join(appDir, specRel)

const exists = await fs.stat(specAbs).then(() => true).catch(() => false)
if (!exists) {
  process.stderr.write(`[snap] no such target: ${specAbs}\n`)
  process.exit(1)
}

const port = process.env.PLAYWRIGHT_PORT ?? "3000"
const env = {
  ...process.env,
  PLAYWRIGHT_SNAP: "1",
  PLAYWRIGHT_WEB_COMMAND:
    process.env.PLAYWRIGHT_WEB_COMMAND ??
    `bun --cwd ${appDir} dev -- --host 127.0.0.1 --port ${port}`,
}

const result = spawnSync(
  "bun",
  ["x", "playwright", "test", specRel, "--project=chromium", "--reporter=line"],
  { stdio: "inherit", cwd: appDir, env },
)
process.exit(result.status ?? 1)
