import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import manifest from "../bundled-tools.json"

// Bundled-tool supply pattern: version-pinned manifest entry, download from a
// pinned GitHub release tag, verify, then land the binary in resources/tools/
// (packaged as extraResources and prepended to the DSH sidecar PATH by
// src/main/dsh-sidecar.ts). Two notable
// properties:
//
// 1. The expected sha256 for every asset is pinned IN THE REPO (bundled-tools
//    .json), not fetched from the release at build time. Fetching a checksum
//    file from the same release it is meant to verify only protects against
//    transfer corruption — a retargeted or tampered release swaps the assets
//    and the checksum file together. With the hash pinned in the repo, moving
//    to a new upstream build always requires a reviewed manifest diff.
// 2. uv ships its release assets as archives (tar.gz on macOS, zip on Windows)
//    containing both `uv` and `uvx`, so this script extracts before placing
//    binaries in resources/tools/.

export type SupportedPlatform = "darwin" | "win32"
export type SupportedArch = "arm64" | "x64"
export interface UvTarget {
  platform: SupportedPlatform
  arch: SupportedArch
}

const execFileAsync = promisify(execFile)
const toolsDir = path.resolve(import.meta.dirname, "../resources/tools")
const uv = manifest.uv

export function uvTargetFor(platform: string, arch: string): UvTarget | null {
  if (!(`${platform}-${arch}` in uv.assets)) return null
  return { platform: platform as SupportedPlatform, arch: arch as SupportedArch }
}

function assetEntryForTarget(platform: SupportedPlatform, arch: SupportedArch) {
  const entry = uv.assets[`${platform}-${arch}` as keyof typeof uv.assets]
  if (!entry) throw new Error(`Unsupported uv target: ${platform}-${arch}`)
  return entry
}

export function assetForTarget(platform: SupportedPlatform, arch: SupportedArch) {
  return assetEntryForTarget(platform, arch).name
}

export function pinnedSha256ForTarget(platform: SupportedPlatform, arch: SupportedArch) {
  return assetEntryForTarget(platform, arch).sha256.toLowerCase()
}

export function binaryNameForPlatform(platform: SupportedPlatform) {
  return platform === "win32" ? "uv.exe" : "uv"
}

export function companionBinaryNameForPlatform(platform: SupportedPlatform) {
  return platform === "win32" ? "uvx.exe" : "uvx"
}

export function runtimeBinaryPath(baseToolsDir: string, platform: SupportedPlatform) {
  return path.join(baseToolsDir, binaryNameForPlatform(platform))
}

export function uvDownloadUrl(version: string, asset: string) {
  return `https://github.com/${uv.repo}/releases/download/${version}/${asset}`
}

export function sha256(data: ArrayBuffer) {
  return createHash("sha256").update(Buffer.from(data)).digest("hex")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function uvVersionMatches(stdout: string, expectedVersion: string) {
  return new RegExp(`\\b${escapeRegExp(expectedVersion)}\\b`).test(stdout)
}

async function fetchBytes(url: string) {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  return response.arrayBuffer()
}

export async function verifyUvVersion(binaryPath: string, expectedVersion: string) {
  const { stdout } = await execFileAsync(binaryPath, ["--version"])
  if (!uvVersionMatches(stdout, expectedVersion)) {
    throw new Error(`uv version mismatch: expected ${expectedVersion}, got ${stdout.trim()}`)
  }
}

async function extractArchive(archivePath: string, asset: string, destDir: string) {
  if (asset.endsWith(".zip")) {
    if (process.platform === "win32") {
      // On Windows CI this script runs under bash, where PATH-resolved `tar`
      // is GNU tar (no zip support) and `unzip` is not guaranteed;
      // PowerShell's Expand-Archive is always present on windows-* images.
      await execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ])
    } else {
      // unzip ships on both macos-* and ubuntu-* GitHub runner images.
      await execFileAsync("unzip", ["-o", archivePath, "-d", destDir])
    }
    return
  }
  if (asset.endsWith(".tar.gz")) {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir])
    return
  }
  throw new Error(`Unsupported uv asset archive format: ${asset}`)
}

async function findFile(rootDir: string, name: string): Promise<string | null> {
  const entries = await readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const found = await findFile(full, name)
      if (found) return found
    }
  }
  return null
}

export async function prepareUv(targetPlatform: SupportedPlatform, targetArch: SupportedArch) {
  const asset = assetForTarget(targetPlatform, targetArch)
  const runtimeName = binaryNameForPlatform(targetPlatform)
  const companionName = companionBinaryNameForPlatform(targetPlatform)
  const assetUrl = uvDownloadUrl(uv.version, asset)
  const expected = pinnedSha256ForTarget(targetPlatform, targetArch)

  const data = await fetchBytes(assetUrl)
  const actual = sha256(data)
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${asset}: expected ${expected} (pinned in bundled-tools.json), got ${actual}. ` +
        `If upstream re-released ${uv.version}, review the release and update the pinned sha256 explicitly.`,
    )
  }

  await mkdir(toolsDir, { recursive: true })
  // Clear every uv binary name regardless of target platform so switching
  // targets (e.g. darwin → win32 in a shared checkout) never leaves a stale
  // binary from the previous platform in resources/tools/.
  for (const stale of ["uv", "uv.exe", "uvx", "uvx.exe"]) {
    await rm(path.join(toolsDir, stale), { force: true })
  }

  const extractDir = await mkdtemp(path.join(tmpdir(), "uv-extract-"))
  try {
    const archivePath = path.join(extractDir, asset)
    await writeFile(archivePath, Buffer.from(data))
    await extractArchive(archivePath, asset, extractDir)

    for (const binaryName of [runtimeName, companionName]) {
      const found = await findFile(extractDir, binaryName)
      if (!found) throw new Error(`Extracted uv archive ${asset} is missing ${binaryName}`)
      const destination = path.join(toolsDir, binaryName)
      // copyFile (not rename): extractDir lives under os.tmpdir(), which can
      // be a different filesystem/device than resources/tools/, and a raw
      // rename() across devices fails with EXDEV.
      await copyFile(found, destination)
      if (targetPlatform !== "win32") await chmod(destination, 0o755)
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true })
  }

  const destination = path.join(toolsDir, runtimeName)
  if (targetPlatform === process.platform && targetArch === process.arch) {
    await verifyUvVersion(destination, uv.version)
  }

  return { asset, destination, version: uv.version }
}

function readArg(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (import.meta.main) {
  const platform = (readArg("--platform") ?? process.platform) as SupportedPlatform
  const arch = (readArg("--arch") ?? process.arch) as SupportedArch
  const result = await prepareUv(platform, arch)
  console.log(`Prepared uv ${result.version} for ${platform}-${arch}: ${result.destination}`)
}
