import { pathToFileURL } from "node:url"

const unsupportedMajor = 25

export function parseNodeMajor(version) {
  const match = /^v?(\d+)(?:\.|$)/.exec(version)
  return match ? Number(match[1]) : Number.NaN
}

export function checkNodeVersion(version = process.version) {
  const major = parseNodeMajor(version)
  if (Number.isNaN(major)) {
    return {
      ok: false,
      message: `Unsupported Node version format: ${version}. Use Node 24 for PawWork dependency installs.`,
    }
  }

  if (major < unsupportedMajor) {
    return { ok: true }
  }

  return {
    ok: false,
    message: [
      "Use Node 24 for PawWork dependency installs.",
      "",
      `Current node: ${version}`,
      "",
      "Node 25+ can make Electron 40.8.0 postinstall leave an incomplete Electron.app while reporting success.",
      "Switch to Node 24 (see .node-version), delete node_modules, then reinstall dependencies.",
      "",
      "macOS/Linux:",
      "  rm -rf node_modules",
      "",
      "PowerShell:",
      "  Remove-Item -Recurse -Force node_modules",
      "",
      "Then reinstall:",
      "  bun install --frozen-lockfile",
    ].join("\n"),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkNodeVersion()
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
}
