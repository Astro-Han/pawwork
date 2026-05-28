import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
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
    const frameworkDir = join(
      electronDir,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    )
    return [
      join(frameworkDir, "Electron Framework"),
      join(frameworkDir, "Versions", "A", "Electron Framework"),
    ].some((candidate) => existsSync(candidate))
  }

  return true
}

export function writeElectronPathFileIfInstallComplete(electronDir, platform = process.platform) {
  if (!isElectronInstallComplete(electronDir, platform)) return false

  writeFileSync(join(electronDir, "path.txt"), platformPathForElectron(platform))
  return true
}

function resetElectronInstall(electronDir) {
  rmSync(join(electronDir, "path.txt"), { force: true })
  rmSync(join(electronDir, "dist"), { recursive: true, force: true })
}

function electronArtifactName({ version, platform, arch }) {
  return `electron-v${version}-${platform}-${arch}.zip`
}

function electronArtifactUrl({ version, platform, arch }) {
  return `https://github.com/electron/electron/releases/download/v${version}/${electronArtifactName({
    version,
    platform,
    arch,
  })}`
}

function downloadFile(url, destination) {
  execFileSync("curl", ["-fL", "--retry", "3", "--retry-delay", "2", "-o", destination, url], { stdio: "inherit" })
}

function verifyElectronZipChecksum(electronDir, zipPath, fileName) {
  const checksums = JSON.parse(readFileSync(join(electronDir, "checksums.json"), "utf8"))
  const expected = checksums[fileName]
  if (typeof expected !== "string") {
    throw new Error(`Missing Electron checksum for artifact: ${fileName}`)
  }

  const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex")
  if (actual !== expected) {
    throw new Error(`Electron checksum mismatch for ${fileName}: expected ${expected}, got ${actual}`)
  }
}

function extractElectronZip(electronDir, zipPath) {
  execFileSync("unzip", ["-q", zipPath, "-d", join(electronDir, "dist")], { stdio: "inherit" })
}

export function downloadElectronArtifact({
  electronDir,
  platform,
  arch,
  download = downloadFile,
  extractZip = extractElectronZip,
}) {
  const { version } = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8"))
  const fileName = electronArtifactName({ version, platform, arch })
  const scratchDir = mkdtempSync(join(tmpdir(), "pawwork-electron-artifact-"))
  const zipPath = join(scratchDir, fileName)

  try {
    download(electronArtifactUrl({ version, platform, arch }), zipPath)
    verifyElectronZipChecksum(electronDir, zipPath, fileName)
    resetElectronInstall(electronDir)
    extractZip(electronDir, zipPath)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

function findZipFile(root) {
  for (const entry of readdirSync(root)) {
    const entryPath = join(root, entry)
    const stats = statSync(entryPath)
    if (stats.isDirectory()) {
      const zipPath = findZipFile(entryPath)
      if (zipPath) return zipPath
    }
    if (stats.isFile() && entryPath.endsWith(".zip")) return entryPath
  }
}

export function extractElectronZipFromCache(cacheRoot, electronDir) {
  const zipPath = findZipFile(cacheRoot)
  if (!zipPath) return false

  resetElectronInstall(electronDir)
  console.warn(`Extracting Electron artifact from isolated cache: ${zipPath}`)
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", join(electronDir, "dist")], { stdio: "inherit" })
  return true
}

export function electronInstallEnv({
  cacheRoot,
  forceNoCache = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
  env.npm_config_platform = platform
  env.npm_config_arch = arch

  if (forceNoCache) {
    env.force_no_cache = "true"
  }

  if (cacheRoot) {
    env.electron_config_cache = cacheRoot
  }

  return env
}

export function repairElectronInstallAt(
  electronDir,
  {
    installScript = join(electronDir, "install.js"),
    platform = process.platform,
    arch = process.arch,
    runInstall,
    createCacheRoot = () => mkdtempSync(join(tmpdir(), "pawwork-electron-cache-")),
    extractFromCache = extractElectronZipFromCache,
  } = {},
) {
  const install =
    runInstall ??
    ((script, options = {}) => {
      execFileSync(process.execPath, [script], {
        stdio: "inherit",
        env: electronInstallEnv({ ...options, platform, arch }),
      })
    })

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    resetElectronInstall(electronDir)
    try {
      install(installScript, { forceNoCache: false })
    } catch {
      // Fall through to the forced no-cache retry below.
    }
  }

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    resetElectronInstall(electronDir)
    const cacheRoot = createCacheRoot()
    install(installScript, {
      cacheRoot,
      forceNoCache: true,
    })

    if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
      extractFromCache(cacheRoot, electronDir)
    }
  }

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    downloadElectronArtifact({ electronDir, platform, arch })
  }

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    throw new Error(`Electron install is still incomplete after repair: ${electronDir}`)
  }

  console.log(`Electron install ready: ${join(electronDir, "dist", platformPathForElectron(platform))}`)
}

export function repairElectronInstall() {
  const electronDir = join(require.resolve("electron/package.json"), "..")
  repairElectronInstallAt(electronDir)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  repairElectronInstall()
}
