import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import manifest from "../bundled-tools.json"

export type SupportedPlatform = "darwin" | "win32"
export type SupportedArch = "arm64" | "x64"

const execFileAsync = promisify(execFile)
const toolsDir = path.resolve(import.meta.dirname, "../resources/tools")
const officeCli = manifest.officecli

export function assetForTarget(platform: SupportedPlatform, arch: SupportedArch) {
  const asset = officeCli.assets[`${platform}-${arch}` as keyof typeof officeCli.assets]
  if (!asset) throw new Error(`Unsupported OfficeCLI target: ${platform}-${arch}`)
  return asset
}

export function binaryNameForPlatform(platform: SupportedPlatform) {
  return platform === "win32" ? "officecli.exe" : "officecli"
}

export function runtimeBinaryPath(baseToolsDir: string, platform: SupportedPlatform) {
  return path.join(baseToolsDir, binaryNameForPlatform(platform))
}

export function officeCliDownloadUrl(version: string, asset: string) {
  return `https://github.com/${officeCli.repo}/releases/download/${version}/${asset}`
}

export function officeCliSha256SumsUrl(version: string) {
  return `https://github.com/${officeCli.repo}/releases/download/${version}/SHA256SUMS`
}

export function parseSha256Sums(text: string) {
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

export async function verifyOfficeCliVersion(binaryPath: string, expectedVersion: string) {
  const { stdout } = await execFileAsync(binaryPath, ["--version"], {
    env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
  })
  const normalized = expectedVersion.replace(/^v/, "")
  if (!stdout.includes(normalized)) {
    throw new Error(`OfficeCLI version mismatch: expected ${expectedVersion}, got ${stdout.trim()}`)
  }
}

export async function prepareOfficeCli(targetPlatform: SupportedPlatform, targetArch: SupportedArch) {
  const asset = assetForTarget(targetPlatform, targetArch)
  const runtimeName = binaryNameForPlatform(targetPlatform)
  const assetUrl = officeCliDownloadUrl(officeCli.version, asset)
  const sums = parseSha256Sums(await fetchText(officeCliSha256SumsUrl(officeCli.version)))
  const expected = sums.get(asset)
  if (!expected) throw new Error(`SHA256SUMS does not include ${asset}`)

  const data = await fetchBytes(assetUrl)
  const actual = sha256(data)
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
  }

  await mkdir(toolsDir, { recursive: true })
  await rm(path.join(toolsDir, "officecli"), { force: true })
  await rm(path.join(toolsDir, "officecli.exe"), { force: true })
  const destination = path.join(toolsDir, runtimeName)
  await writeFile(destination, Buffer.from(data))
  if (targetPlatform !== "win32") await chmod(destination, 0o755)

  if (targetPlatform === process.platform && targetArch === process.arch) {
    await verifyOfficeCliVersion(destination, officeCli.version)
  }

  return { asset, destination, version: officeCli.version }
}

function readArg(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (import.meta.main) {
  const platform = (readArg("--platform") ?? process.platform) as SupportedPlatform
  const arch = (readArg("--arch") ?? process.arch) as SupportedArch
  const result = await prepareOfficeCli(platform, arch)
  console.log(`Prepared OfficeCLI ${result.version} for ${platform}-${arch}: ${result.destination}`)
}
