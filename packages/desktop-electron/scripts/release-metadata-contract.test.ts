import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const roots: string[] = []
const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = dirname(scriptDir)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function spawnFinalizer(binDir: string, latestDir: string, runnerTemp: string, env: Record<string, string> = {}) {
  return Bun.spawn({
    cmd: ["bun", "./scripts/finalize-latest-yml.ts"],
    cwd: packageDir,
    env: {
      ...process.env,
      GH_REPO: "Astro-Han/pawwork",
      LATEST_YML_DIR: latestDir,
      OPENCODE_VERSION: "0.2.4",
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runnerTemp,
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
}

describe("release metadata finalizer", () => {
  test("merges macOS and Windows updater metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFakeGh(binDir)

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-arm64.zip")
    writeLatest(join(latestDir, "latest-yml-x86_64-apple-darwin"), "latest-mac.yml", "PawWork-x64.zip")
    writeLatest(join(latestDir, "latest-yml-x86_64-pc-windows-msvc"), "latest.yml", "PawWork Setup.exe")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp)

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(`${stdout}${stderr}`).toContain("finalized latest yml files")
    expect(readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")).toContain("PawWork-arm64.zip")
    expect(readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")).toContain("PawWork-x64.zip")
    expect(readFileSync(join(runnerTemp, "latest.yml"), "utf8")).toContain("PawWork Setup.exe")
    const uploads = readFileSync(join(root, "gh-uploads.log"), "utf8")
    expect(uploads).toContain("release upload v0.2.4")
    expect(uploads).toContain("latest-mac.yml")
    expect(uploads).toContain("latest.yml")
  })

  test("preserves existing macOS metadata when finalizing one architecture", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFakeGh(binDir, {
      "latest-mac.yml": "PawWork-existing-x64.zip",
    })

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp)

    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    const latestMac = readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")
    expect(latestMac).toContain("PawWork-new-arm64.zip")
    expect(latestMac).toContain("PawWork-existing-x64.zip")
  })

  test("merges live metadata into the predownloaded snapshot baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    const snapshotDir = join(root, "snapshot")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFakeGh(binDir, {
      "latest-mac.yml": "PawWork-live-x64.zip",
    })
    writeLatest(snapshotDir, "latest-mac.yml", "PawWork-stale-x64.zip")

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp, { EXISTING_LATEST_YML_DIR: snapshotDir })

    expect(await proc.exited).toBe(0)
    const latestMac = readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")
    expect(latestMac).toContain("PawWork-new-arm64.zip")
    expect(latestMac).toContain("PawWork-live-x64.zip")
    expect(latestMac).toContain("PawWork-stale-x64.zip")
  })

  test("does not collide when EXISTING_LATEST_YML_DIR is RUNNER_TEMP/existing-latest-yml", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    const snapshotDir = join(runnerTemp, "existing-latest-yml")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFakeGh(binDir, {
      "latest-mac.yml": "PawWork-live-x64.zip",
    })
    writeLatest(snapshotDir, "latest-mac.yml", "PawWork-snapshot-x64.zip")

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp, { EXISTING_LATEST_YML_DIR: snapshotDir })

    expect(await proc.exited).toBe(0)
    const latestMac = readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")
    expect(latestMac).toContain("PawWork-new-arm64.zip")
    expect(latestMac).toContain("PawWork-live-x64.zip")
    expect(latestMac).toContain("PawWork-snapshot-x64.zip")
  })

  test("uses live integrity metadata when live and snapshot urls collide", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    const snapshotDir = join(root, "snapshot")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFakeGh(binDir, {
      "latest-mac.yml": { url: "PawWork-x64.zip", sha512: "live-sha", size: 222 },
    })
    writeLatest(snapshotDir, "latest-mac.yml", "PawWork-x64.zip", { sha512: "stale-sha", size: 111 })

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp, { EXISTING_LATEST_YML_DIR: snapshotDir })

    expect(await proc.exited).toBe(0)
    const latestMac = readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")
    expect(latestMac).toContain("PawWork-x64.zip")
    expect(latestMac).toContain("live-sha")
    expect(latestMac).toContain("size: 222")
    expect(latestMac).not.toContain("stale-sha")
    expect(latestMac).not.toContain("size: 111")
  })

  test("uses predownloaded metadata when live metadata is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    const snapshotDir = join(root, "snapshot")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFakeGh(binDir, {}, "no matches found")
    writeLatest(snapshotDir, "latest-mac.yml", "PawWork-snapshot-x64.zip")

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp, { EXISTING_LATEST_YML_DIR: snapshotDir })

    expect(await proc.exited).toBe(0)
    const latestMac = readFileSync(join(runnerTemp, "latest-mac.yml"), "utf8")
    expect(latestMac).toContain("PawWork-new-arm64.zip")
    expect(latestMac).toContain("PawWork-snapshot-x64.zip")
  })

  test("fails when existing metadata download has a non-missing error", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFakeGh(binDir, {}, "rate limit exceeded")

    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp)

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Failed to download existing latest-mac.yml")
    expect(stderr).toContain("rate limit exceeded")
  })

  test("fails when existing metadata download returns a generic not-found error", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    const snapshotDir = join(root, "snapshot")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFakeGh(binDir, {}, "HTTP 404: Not Found")
    writeLatest(snapshotDir, "latest-mac.yml", "PawWork-snapshot-x64.zip")
    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp, { EXISTING_LATEST_YML_DIR: snapshotDir })

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Failed to download existing latest-mac.yml")
    expect(stderr).toContain("HTTP 404: Not Found")
  })

  test("fails when existing metadata version does not match the release", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-release-metadata-"))
    roots.push(root)
    const latestDir = join(root, "latest-yml")
    const runnerTemp = join(root, "runner")
    const binDir = join(root, "bin")
    const snapshotDir = join(root, "snapshot")
    mkdirSync(runnerTemp, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    writeFakeGh(binDir, {}, "no matches found")
    writeLatest(snapshotDir, "latest-mac.yml", "PawWork-old-x64.zip", { version: "0.2.3" })
    writeLatest(join(latestDir, "latest-yml-aarch64-apple-darwin"), "latest-mac.yml", "PawWork-new-arm64.zip")

    const proc = spawnFinalizer(binDir, latestDir, runnerTemp, { EXISTING_LATEST_YML_DIR: snapshotDir })

    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Existing latest-mac.yml from EXISTING_LATEST_YML_DIR has version 0.2.3")
  })
})

type FixtureFile = {
  url: string
  sha512?: string
  size?: number
}

function fixtureFile(value: string | FixtureFile): Required<FixtureFile> {
  if (typeof value === "string") return { url: value, sha512: "abc123", size: 123 }
  return { url: value.url, sha512: value.sha512 ?? "abc123", size: value.size ?? 123 }
}

function writeLatest(
  dir: string,
  filename: string,
  url: string,
  options: { sha512?: string; size?: number; version?: string } = {},
) {
  const file = fixtureFile({ url, ...options })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, filename),
    [
      `version: ${options.version ?? "0.2.4"}`,
      "files:",
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
      "releaseDate: '2026-04-21T00:00:00.000Z'",
      "",
    ].join("\n"),
    "utf8",
  )
}

function writeFakeGh(binDir: string, downloads: Record<string, string | FixtureFile> = {}, downloadFailure?: string) {
  const helper = join(binDir, "fake-gh.js")
  writeFileSync(
    helper,
    [
      "const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      `const downloads = ${JSON.stringify(downloads)}`,
      `const downloadFailure = ${JSON.stringify(downloadFailure ?? null)}`,
      `const uploadLog = ${JSON.stringify(join(binDir, "..", "gh-uploads.log"))}`,
      "const args = process.argv.slice(2)",
      "if (args[0] === 'release' && args[1] === 'download') {",
      "  if (downloadFailure) {",
      "    console.error(downloadFailure)",
      "    process.exit(1)",
      "  }",
      "  let dir = ''",
      "  let pattern = ''",
      "  for (let index = 0; index < args.length; index++) {",
      "    if (args[index] === '--dir') dir = args[++index] ?? ''",
      "    else if (args[index] === '--pattern') pattern = args[++index] ?? ''",
      "  }",
      "  mkdirSync(dir, { recursive: true })",
      "  if (!downloads[pattern]) {",
      "    console.error(`no matches found for ${pattern}`)",
      "    process.exit(1)",
      "  }",
      "  const target = join(dir, pattern)",
      "  if (existsSync(target) && !args.includes('--clobber') && !args.includes('-c')) {",
      "    console.error(`${target} already exists (use clobber to overwrite file or skip-existing to skip file)`)",
      "    process.exit(1)",
      "  }",
      "  writeFileSync(target, latestYml(downloads[pattern]), 'utf8')",
      "  process.exit(0)",
      "}",
      "appendFileSync(uploadLog, `${args.join(' ')}\\n`, 'utf8')",
      "function latestYml(value) {",
      "  const file = typeof value === 'string' ? { url: value, sha512: 'abc123', size: 123 } : { sha512: 'abc123', size: 123, ...value }",
      "  return [",
      "    'version: 0.2.4',",
      "    'files:',",
      "    `  - url: ${file.url}`,",
      "    `    sha512: ${file.sha512}`,",
      "    `    size: ${file.size}`,",
      "    \"releaseDate: '2026-04-21T00:00:00.000Z'\",",
      "    '',",
      "  ].join('\\n')",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )

  if (process.platform === "win32") {
    const script = join(binDir, "gh.cmd")
    writeFileSync(script, `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`, "utf8")
    return
  }

  const script = join(binDir, "gh")
  writeFileSync(script, `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, "utf8")
  chmodSync(script, 0o755)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
