import { execFileSync } from "node:child_process"
import { existsSync, rmSync, writeFileSync } from "node:fs"
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

export function isElectronInstallComplete(electronDir, platform = process.platform) {
  const platformPath = platformPathForElectron(platform)
  const binaryPath = join(electronDir, "dist", platformPath)
  if (!existsSync(binaryPath)) return false

  if (platform === "darwin" || platform === "mas") {
    return existsSync(
      join(
        electronDir,
        "dist",
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      ),
    )
  }

  return true
}

export function writeElectronPathFileIfInstallComplete(electronDir, platform = process.platform) {
  if (!isElectronInstallComplete(electronDir, platform)) return false

  writeFileSync(join(electronDir, "path.txt"), platformPathForElectron(platform))
  return true
}

export function repairElectronInstall(options = {}) {
  const platform = options.platform ?? process.platform
  const electronDir = options.electronDir ?? join(require.resolve("electron/package.json"), "..")
  const installScript = join(electronDir, "install.js")
  const runInstall = options.runInstall ?? (() => execFileSync(process.execPath, [installScript], { stdio: "inherit" }))

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    rmSync(join(electronDir, "path.txt"), { force: true })
    rmSync(join(electronDir, "dist"), { force: true, recursive: true })
    runInstall(installScript)
  }

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    throw new Error(`Electron install is still incomplete after repair: ${electronDir}`)
  }

  console.log(`Electron install ready: ${join(electronDir, "dist", platformPathForElectron(platform))}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  repairElectronInstall()
}
