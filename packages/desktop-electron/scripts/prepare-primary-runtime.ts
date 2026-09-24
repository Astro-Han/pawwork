import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import packageJson from "../package.json"
import lock from "../primary-runtime.lock.json"
import { powershellExpandArchiveArgs, type SupportedArch, type SupportedPlatform } from "./prepare-uv"

// The Python payload DSH's `load_workspace_dependencies` tool serves, in the
// layout that tool reads (runtime.json + dependencies/python). The lock is
// upstream's scripts/primary-runtime/lock.json copied verbatim, so the
// interpreter and every library match DSH's own desktop build byte for byte;
// update it by copying the new upstream file, never by hand.

type TargetKey = keyof typeof lock.targets

const execFileAsync = promisify(execFile)
const outputDir = path.resolve(import.meta.dirname, "../resources/runtime/primary-runtime")
const cacheDir = path.join(tmpdir(), "pawwork-primary-runtime-downloads")

export function targetKey(platform: SupportedPlatform, arch: SupportedArch): TargetKey {
  const key = `${platform === "win32" ? "win" : "mac"}-${arch}`
  if (!Object.hasOwn(lock.targets, key)) throw new Error(`Unsupported primary runtime target: ${platform}-${arch}`)
  return key as TargetKey
}

export function pythonArchiveUrl(key: TargetKey) {
  const file = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${lock.targets[key].pythonTarget}-install_only_stripped.tar.gz`
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(file)}`
}

export function sitePackages(root: string, platform: SupportedPlatform) {
  const version = lock.pythonVersion.split(".").slice(0, 2).join(".")
  return platform === "win32"
    ? path.join(root, "dependencies", "python", "Lib", "site-packages")
    : path.join(root, "dependencies", "python", "lib", `python${version}`, "site-packages")
}

export function pythonExecutable(root: string, platform: SupportedPlatform) {
  return platform === "win32"
    ? path.join(root, "dependencies", "python", "python.exe")
    : path.join(root, "dependencies", "python", "bin", "python3")
}

async function download(url: string, sha256: string) {
  await mkdir(cacheDir, { recursive: true })
  const cached = path.join(cacheDir, sha256)
  let bytes: Buffer
  try {
    bytes = await readFile(cached)
  } catch {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== sha256) throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`)
  await writeFile(cached, bytes)
  return cached
}

async function unpackWheel(wheel: string, destination: string) {
  if (process.platform === "win32") {
    // Expand-Archive refuses any extension but .zip.
    const staging = await mkdtemp(path.join(tmpdir(), "wheel-"))
    try {
      const zip = path.join(staging, "wheel.zip")
      await copyFile(wheel, zip)
      await execFileAsync("powershell.exe", powershellExpandArchiveArgs(zip, destination))
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } else {
    await execFileAsync("unzip", ["-o", "-q", wheel, "-d", destination])
  }
}

// A wheel's <dist>.data/<scheme>/ directories name install locations outside
// site-packages. Only `scripts` is harmless to leave in place (no command
// wrappers are generated); anything else would be a library installed wrong.
export async function assertOnlyScriptsData(site: string) {
  for (const entry of await readdir(site, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".data")) continue
    const schemes = (await readdir(path.join(site, entry.name))).filter((scheme) => scheme !== "scripts")
    if (schemes.length > 0) throw new Error(`Wheel ${entry.name} needs unsupported install paths: ${schemes.join(", ")}`)
  }
}

export async function preparePrimaryRuntime(platform: SupportedPlatform, arch: SupportedArch) {
  const key = targetKey(platform, arch)
  const target = lock.targets[key]
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(path.join(outputDir, "dependencies"), { recursive: true })

  const python = await download(pythonArchiveUrl(key), target.pythonSha256)
  // On Windows, PATH may resolve `tar` to Git Bash's GNU tar, which misreads drive-letter paths.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
  await execFileAsync(tar, ["-xzf", python, "-C", path.join(outputDir, "dependencies")])

  const site = sitePackages(outputDir, platform)
  for (const wheel of [...target.wheels, ...lock.wheels]) await unpackWheel(await download(wheel.url, wheel.sha256), site)
  await assertOnlyScriptsData(site)

  const manifest = {
    desktopVersion: packageJson.version,
    platform,
    arch,
    python: lock.pythonVersion,
    pythonPackages: lock.pythonPackages,
  }
  await writeFile(path.join(outputDir, "runtime.json"), `${JSON.stringify(manifest, undefined, 2)}\n`)

  if (platform === process.platform && arch === process.arch) {
    const interpreter = pythonExecutable(outputDir, platform)
    await execFileAsync(interpreter, ["-I", "-B", "-c", "import docx, pptx, openpyxl, xlsxwriter, PIL, lxml, numpy, pandas"])
    await execFileAsync(interpreter, ["-I", "-B", "-m", "pip", "check"])
  }
  return { key, outputDir }
}

function readArg(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (import.meta.main) {
  const platform = (readArg("--platform") ?? process.platform) as SupportedPlatform
  const arch = (readArg("--arch") ?? process.arch) as SupportedArch
  const result = await preparePrimaryRuntime(platform, arch)
  console.log(`Prepared Python ${lock.pythonVersion} for ${result.key}: ${result.outputDir}`)
}
