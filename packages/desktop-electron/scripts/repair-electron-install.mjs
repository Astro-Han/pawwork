import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import process from "node:process"

const require = createRequire(import.meta.url)

export function platformPathForElectron(platform = process.platform) {
  switch (platform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron"
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron"
    case "win32":
      return "electron.exe"
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

export function writeElectronPathFileIfBinaryExists(electronDir, platform = process.platform) {
  const platformPath = platformPathForElectron(platform)
  const binaryPath = join(electronDir, "dist", platformPath)
  if (!existsSync(binaryPath)) return false

  writeFileSync(join(electronDir, "path.txt"), platformPath)
  return true
}

export function repairElectronInstall() {
  const electronDir = join(require.resolve("electron/package.json"), "..")
  const installScript = join(electronDir, "install.js")

  if (!writeElectronPathFileIfBinaryExists(electronDir)) {
    execFileSync(process.execPath, [installScript], { stdio: "inherit" })
  }

  if (!writeElectronPathFileIfBinaryExists(electronDir)) {
    throw new Error(`Electron install is still incomplete after repair: ${electronDir}`)
  }

  console.log(`Electron install ready: ${join(electronDir, "dist", platformPathForElectron())}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  repairElectronInstall()
}
