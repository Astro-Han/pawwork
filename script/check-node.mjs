import { pathToFileURL } from "node:url"

const unsupportedMajor = 25

export function parseNodeMajor(version) {
  const match = /^v?(\d+)\./.exec(version)
  if (!match) {
    throw new Error(`Unsupported Node version format: ${version}`)
  }
  return Number(match[1])
}

export function checkNodeVersion(version = process.version) {
  const major = parseNodeMajor(version)
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
      "Switch to Node 24 (see .node-version), then reinstall dependencies:",
      "",
      "  rm -rf node_modules",
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
