#!/usr/bin/env bun
import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const rootDir = resolve(import.meta.dir, "../../..")
const bridgeDir = join(rootDir, "packages", "remote-bridge")
const toolsDir = join(import.meta.dir, "..", "resources", "tools")
const binary = process.platform === "win32" ? "pawwork-remote-bridge.exe" : "pawwork-remote-bridge"

await mkdir(toolsDir, { recursive: true })
await execFileAsync("go", ["build", "-o", join(toolsDir, binary), "./cmd/pawwork-remote-bridge"], {
  cwd: bridgeDir,
})
