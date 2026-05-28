import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { get } from "node:https"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

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

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const location = response.headers.location
      if (
        response.statusCode !== undefined &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        location !== undefined
      ) {
        response.resume()
        if (redirects >= 5) {
          reject(new Error(`Too many redirects while downloading Electron artifact: ${url}`))
          return
        }
        downloadFile(new URL(location, url).toString(), destination, redirects + 1).then(resolve, reject)
        return
      }

      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Failed to download Electron artifact (${response.statusCode}): ${url}`))
        return
      }

      const file = createWriteStream(destination)
      response.pipe(file)
      file.on("finish", () => file.close(resolve))
      file.on("error", reject)
    })

    request.on("error", reject)
  })
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
  const electronRequire = createRequire(join(electronDir, "install.js"))
  const extract = electronRequire("extract-zip")
  return extract(zipPath, { dir: join(electronDir, "dist") })
}

export async function downloadElectronArtifact({
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
    await download(electronArtifactUrl({ version, platform, arch }), zipPath)
    verifyElectronZipChecksum(electronDir, zipPath, fileName)
    resetElectronInstall(electronDir)
    await extractZip(electronDir, zipPath)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
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
    install(installScript, {
      cacheRoot: mkdtempSync(join(tmpdir(), "pawwork-electron-cache-")),
      forceNoCache: true,
    })
  }

  if (!writeElectronPathFileIfInstallComplete(electronDir, platform)) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--download-artifact", electronDir, platform, arch], {
      stdio: "inherit",
    })
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
  if (process.argv[2] === "--download-artifact") {
    const [, , , electronDir, platform, arch] = process.argv
    await downloadElectronArtifact({ electronDir, platform, arch })
  } else {
    repairElectronInstall()
  }
}
