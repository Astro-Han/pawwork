const unsupportedMajor = 25
const version = process.version
const match = /^v?(\d+)(?:\.|$)/.exec(version)

let errorMessage = ""

if (!match) {
  errorMessage = `Unsupported Node version format: ${version}. Use Node 24 for PawWork dependency installs.`
}

if (match && Number(match[1]) >= unsupportedMajor) {
  errorMessage = [
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
  ].join("\n")
}

if (errorMessage) {
  console.error(errorMessage)
  process.exit(1)
}
