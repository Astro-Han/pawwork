import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import manifest from "../bundled-tools.json"

// Mirrors the OfficeCLI supply pattern in prepare-officecli.ts: version-pinned
// manifest entry, download from a pinned GitHub release tag, verify against
// the release's published checksums, then land the binary in
// resources/tools/ (packaged as extraResources → PATH via bundledToolsDir()
// in packages/opencode/src/util/env.ts — same mechanism, no special-casing
// per tool). Unlike OfficeCLI, uv ships its release assets as archives
// (tar.gz on macOS, zip on Windows) containing both `uv` and `uvx`, so this
// script additionally extracts before placing binaries in resources/tools/.

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

export function assetForTarget(platform: SupportedPlatform, arch: SupportedArch) {
  const asset = uv.assets[`${platform}-${arch}` as keyof typeof uv.assets]
  if (!asset) throw new Error(`Unsupported uv target: ${platform}-${arch}`)
  return asset
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

export function uvSha256SumUrl(version: string) {
  return `https://github.com/${uv.repo}/releases/download/${version}/sha256.sum`
}

// uv publishes one combined checksum file per release with lines shaped like
// "<sha256> *<asset-name>" (or without the asterisk) — the same shape as
// OfficeCLI's SHA256SUMS. The parsing rule is duplicated here (rather than
// imported from prepare-officecli.ts) so the two vendor scripts stay
// independent and neither can regress the other on a rename/refactor.
export function parseSha256Sum(text: string) {
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (!match) continue
    entries.set(match[2].trim(), match[1].toLowerCase())
  }
  return entries
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

async function fetchText(url: string) {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  return response.text()
}

export async function verifyUvVersion(binaryPath: string, expectedVersion: string) {
  const { stdout } = await execFileAsync(binaryPath, ["--version"])
  if (!uvVersionMatches(stdout, expectedVersion)) {
    throw new Error(`uv version mismatch: expected ${expectedVersion}, got ${stdout.trim()}`)
  }
}

async function extractArchive(archivePath: string, asset: string, destDir: string) {
  if (asset.endsWith(".zip")) {
    await execFileAsync("unzip", ["-o", archivePath, "-d", destDir])
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
  const sums = parseSha256Sum(await fetchText(uvSha256SumUrl(uv.version)))
  const expected = sums.get(asset)
  if (!expected) throw new Error(`sha256.sum does not include ${asset}`)

  const data = await fetchBytes(assetUrl)
  const actual = sha256(data)
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
  }

  await mkdir(toolsDir, { recursive: true })
  const extractDir = await mkdtemp(path.join(tmpdir(), "uv-extract-"))
  try {
    const archivePath = path.join(extractDir, asset)
    await writeFile(archivePath, Buffer.from(data))
    await extractArchive(archivePath, asset, extractDir)

    for (const binaryName of [runtimeName, companionName]) {
      const found = await findFile(extractDir, binaryName)
      if (!found) throw new Error(`Extracted uv archive ${asset} is missing ${binaryName}`)
      const destination = path.join(toolsDir, binaryName)
      await rm(destination, { force: true })
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
