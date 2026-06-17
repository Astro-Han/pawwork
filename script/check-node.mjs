const version = process.version
const match = /^v?(\d+)(?:\.|$)/.exec(version)

if (!match) {
  console.error(`Unsupported Node version format: ${version}.`)
  process.exit(1)
}
