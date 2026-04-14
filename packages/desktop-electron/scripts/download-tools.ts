/**
 * Download bundled CLI tools for the current (or target) platform.
 * Usage: bun ./scripts/download-tools.ts [--platform darwin|win32] [--arch arm64|x64]
 */
import { execSync } from "node:child_process"
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { pipeline } from "node:stream/promises"
import path from "node:path"

const TOOLS_DIR = path.resolve(import.meta.dirname, "../resources/tools")

const platform = process.argv.includes("--platform")
  ? process.argv[process.argv.indexOf("--platform") + 1]
  : process.platform

const arch = process.argv.includes("--arch")
  ? process.argv[process.argv.indexOf("--arch") + 1]
  : process.arch

console.log(`Downloading tools for ${platform}-${arch}...`)
mkdirSync(TOOLS_DIR, { recursive: true })

// --- Tool definitions ---

interface Tool {
  name: string
  getUrl: (platform: string, arch: string) => string | null
  getBinaryName: (platform: string) => string
  extract?: "tar.gz" | "zip" | "none"
  stripComponents?: number
}

const tools: Tool[] = [
  {
    name: "officecli",
    getUrl: (p, a) => {
      const map: Record<string, string> = {
        "darwin-arm64": "officecli-mac-arm64",
        "darwin-x64": "officecli-mac-x64",
        "win32-x64": "officecli-win-x64.exe",
        "win32-arm64": "officecli-win-arm64.exe",
      }
      const file = map[`${p}-${a}`]
      if (!file) return null
      return `https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/${file}`
    },
    getBinaryName: (p) => (p === "win32" ? "officecli.exe" : "officecli"),
    extract: "none",
  },
  {
    name: "lark-cli",
    getUrl: (_p, _a) => {
      // lark-cli is distributed via npm with platform-specific Go binary inside
      // We extract it from the npm package
      return null // handled separately
    },
    getBinaryName: (p) => (p === "win32" ? "lark-cli.exe" : "lark-cli"),
  },
  {
    name: "dws",
    getUrl: (p, a) => {
      const map: Record<string, string> = {
        "darwin-arm64": "dws-darwin-arm64.tar.gz",
        "darwin-x64": "dws-darwin-amd64.tar.gz",
        "win32-x64": "dws-windows-amd64.zip",
        "win32-arm64": "dws-windows-arm64.zip",
      }
      const file = map[`${p}-${a}`]
      if (!file) return null
      return `https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/latest/download/${file}`
    },
    getBinaryName: (p) => (p === "win32" ? "dws.exe" : "dws"),
    extract: "tar.gz",
  },
]

// --- Download helpers ---

async function download(url: string, dest: string) {
  console.log(`  Downloading ${url}`)
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const fileStream = createWriteStream(dest)
  await pipeline(res.body as any, fileStream)
}

async function downloadTool(tool: Tool) {
  const url = tool.getUrl(platform, arch)
  if (!url) {
    console.log(`  Skipping ${tool.name} (no URL for ${platform}-${arch})`)
    return
  }

  const binaryName = tool.getBinaryName(platform)
  const destPath = path.join(TOOLS_DIR, binaryName)

  if (existsSync(destPath)) {
    console.log(`  ${tool.name}: already exists, skipping`)
    return
  }

  const ext = tool.extract ?? (url.endsWith(".tar.gz") ? "tar.gz" : url.endsWith(".zip") ? "zip" : "none")

  if (ext === "none") {
    await download(url, destPath)
    if (platform !== "win32") chmodSync(destPath, 0o755)
  } else if (ext === "tar.gz") {
    const tmpFile = destPath + ".tar.gz"
    await download(url, tmpFile)
    execSync(`tar -xzf "${tmpFile}" -C "${TOOLS_DIR}"`, { stdio: "inherit" })
    unlinkSync(tmpFile)
    // dws extracts to a file named 'dws' directly
    if (platform !== "win32") chmodSync(destPath, 0o755)
  } else if (ext === "zip") {
    const tmpFile = destPath + ".zip"
    await download(url, tmpFile)
    execSync(`unzip -o "${tmpFile}" -d "${TOOLS_DIR}"`, { stdio: "inherit" })
    unlinkSync(tmpFile)
  }

  console.log(`  ${tool.name}: done → ${binaryName}`)
}

async function downloadLarkCli() {
  const binaryName = platform === "win32" ? "lark-cli.exe" : "lark-cli"
  const destPath = path.join(TOOLS_DIR, binaryName)

  if (existsSync(destPath)) {
    console.log(`  lark-cli: already exists, skipping`)
    return
  }

  // lark-cli binary is inside the npm package at bin/lark-cli
  // Check if it's installed globally or in node_modules
  const globalPath = `/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli`
  if (existsSync(globalPath)) {
    console.log(`  lark-cli: copying from global npm install`)
    execSync(`cp "${globalPath}" "${destPath}"`)
    chmodSync(destPath, 0o755)
    console.log(`  lark-cli: done → ${binaryName}`)
    return
  }

  // Fallback: install temporarily and extract
  console.log(`  lark-cli: installing via npm to extract binary...`)
  const tmpDir = path.join(TOOLS_DIR, ".lark-tmp")
  mkdirSync(tmpDir, { recursive: true })
  execSync(`npm install @larksuite/cli --prefix "${tmpDir}" --ignore-scripts=false`, { stdio: "inherit" })
  const binPath = path.join(tmpDir, "node_modules/@larksuite/cli/bin/lark-cli")
  if (existsSync(binPath)) {
    renameSync(binPath, destPath)
    if (platform !== "win32") chmodSync(destPath, 0o755)
  }
  execSync(`rm -rf "${tmpDir}"`)
  console.log(`  lark-cli: done → ${binaryName}`)
}

async function downloadWecomCli() {
  const binaryName = platform === "win32" ? "wecom-cli.exe" : "wecom-cli"
  const destPath = path.join(TOOLS_DIR, binaryName)

  if (existsSync(destPath)) {
    console.log(`  wecom-cli: already exists, skipping`)
    return
  }

  // wecom-cli is distributed via npm platform-specific packages
  const platformMap: Record<string, string> = {
    "darwin-arm64": "@wecom/cli-darwin-arm64",
    "darwin-x64": "@wecom/cli-darwin-x64",
    "win32-x64": "@wecom/cli-win32-x64",
    "linux-x64": "@wecom/cli-linux-x64",
  }
  const pkg = platformMap[`${platform}-${arch}`]
  if (!pkg) {
    console.log(`  wecom-cli: no package for ${platform}-${arch}, skipping`)
    return
  }

  console.log(`  wecom-cli: installing ${pkg} to extract binary...`)
  const tmpDir = path.join(TOOLS_DIR, ".wecom-tmp")
  mkdirSync(tmpDir, { recursive: true })
  execSync(`npm install ${pkg} --prefix "${tmpDir}"`, { stdio: "inherit" })

  // Find the binary inside the package
  const pkgDir = path.join(tmpDir, "node_modules", pkg)
  const candidates = ["wecom-cli", "wecom-cli.exe", "bin/wecom-cli", "bin/wecom-cli.exe"]
  for (const c of candidates) {
    const p = path.join(pkgDir, c)
    if (existsSync(p)) {
      renameSync(p, destPath)
      if (platform !== "win32") chmodSync(destPath, 0o755)
      break
    }
  }
  execSync(`rm -rf "${tmpDir}"`)
  console.log(`  wecom-cli: done → ${binaryName}`)
}

// --- Main ---

async function main() {
  for (const tool of tools) {
    if (tool.name === "lark-cli") continue // handled separately
    await downloadTool(tool)
  }
  await downloadLarkCli()
  await downloadWecomCli()

  console.log(`\nAll tools downloaded to ${TOOLS_DIR}`)
  execSync(`ls -lh "${TOOLS_DIR}"`, { stdio: "inherit" })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
