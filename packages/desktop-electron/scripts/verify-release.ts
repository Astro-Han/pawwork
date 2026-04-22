export type GithubAsset = {
  name: string
  browser_download_url: string
}

// Minimal GitHub Release API subset used by the release verifier.
export type GithubRelease = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: GithubAsset[]
}

type VerificationInput = {
  release: GithubRelease
  latestYml?: string
  latestMacYml?: string
  startupLog?: string
}

const DEFAULT_REPO = "Astro-Han/pawwork"
const FETCH_TIMEOUT_MS = 15_000

const REQUIRED_ASSETS = [
  "pawwork-mac-arm64.dmg",
  "pawwork-mac-arm64.zip",
  "pawwork-mac-arm64.zip.blockmap",
  "pawwork-mac-x64.dmg",
  "pawwork-mac-x64.zip",
  "pawwork-mac-x64.zip.blockmap",
  "pawwork-win-x64.exe",
  "pawwork-win-x64.exe.blockmap",
  "latest.yml",
  "latest-mac.yml",
]

export function parseUpdaterFileUrls(source: string) {
  const urls: string[] = []

  // This intentionally parses only the electron-builder metadata fields we verify.
  // It is not a general YAML parser and ignores block scalars, multiline values,
  // and other YAML forms that electron-builder does not emit for these fields.
  for (const line of source.split(/\r?\n/)) {
    const fileMatch = line.match(/^\s*-\s+url:\s*(.+?)\s*$/)
    if (fileMatch) {
      urls.push(parseYamlScalar(fileMatch[1]))
      continue
    }

    const pathMatch = line.match(/^\s*path:\s*(.+?)\s*$/)
    if (pathMatch) urls.push(parseYamlScalar(pathMatch[1]))
  }

  return urls
}

function parseYamlScalar(value: string) {
  const trimmed = stripInlineComment(value).trim()
  const quote = trimmed[0]
  if ((quote === `"` || quote === `'`) && trimmed.at(-1) === quote) return trimmed.slice(1, -1)
  return trimmed
}

function stripInlineComment(value: string) {
  let quote: string | undefined

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if ((char === `"` || char === `'`) && !isEscaped(value, index)) {
      quote = quote === char ? undefined : quote ?? char
      continue
    }

    // The fallback space makes a leading # behave as a comment marker.
    if (!quote && char === "#" && /\s/.test(value[index - 1] ?? " ")) {
      return value.slice(0, index)
    }
  }

  return value
}

function isEscaped(value: string, index: number) {
  let slashCount = 0
  for (let slashIndex = index - 1; slashIndex >= 0 && value[slashIndex] === "\\"; slashIndex -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function hasUpdaterEntry(urls: string[], expected: string) {
  // electron-builder may emit either a bare filename or a full download URL.
  return urls.some((url) => url === expected || url.endsWith(`/${expected}`))
}

function assetNameFromUrl(url: string) {
  return url.split("/").at(-1) ?? url
}

function verifyReferencedAssets(sourceName: string, urls: string[], assetNames: Set<string>, failures: string[]) {
  for (const url of urls) {
    const asset = assetNameFromUrl(url)
    if (!assetNames.has(asset)) failures.push(`${sourceName} references missing release asset: ${asset}`)
  }
}

function latestStartupAttempt(source: string) {
  const marker = "app starting"
  const index = source.lastIndexOf(marker)
  if (index === -1) return undefined
  return source.slice(index)
}

function firstLine(source: string) {
  return source.split(/\r?\n/, 1)[0] ?? ""
}

function hasInitDone(source: string) {
  return source.split(/\r?\n/).some((line) => line.trim().endsWith("init done"))
}

function hasServerReady(source: string) {
  return source.split(/\r?\n/).some((line) => /\bserver ready\b/.test(line) && /\{\s*url:\s*['"]/.test(line))
}

function releaseVersion(tag: string) {
  return normalizeTag(tag).slice(1)
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasStartupVersion(startupLine: string, expectedVersion: string) {
  return new RegExp(`version:\\s*['"]${escapeRegExp(expectedVersion)}['"]`).test(startupLine)
}

function hasPackagedStartup(startupLine: string) {
  return /packaged:\s*true/.test(startupLine)
}

export function verifyStartupLog(source: string, expectedTag: string) {
  const failures: string[] = []
  const latest = latestStartupAttempt(source)

  if (!latest) {
    failures.push("Latest startup log does not include any app starting entry")
    return failures
  }

  const startupLine = firstLine(latest)
  let expectedVersion: string | undefined
  try {
    expectedVersion = releaseVersion(expectedTag)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }

  if (expectedVersion && !hasStartupVersion(startupLine, expectedVersion)) {
    failures.push(`Latest startup log version does not match expected ${expectedVersion}`)
  }
  if (!hasPackagedStartup(startupLine)) failures.push("Latest startup log does not include packaged true")
  if (!hasServerReady(latest)) failures.push("Latest startup log does not include server ready")
  if (!latest.includes("loading task finished")) failures.push("Latest startup log does not include loading task finished")
  if (!hasInitDone(latest)) failures.push("Latest startup log does not include init step done")

  return failures
}

export function verifyReleasePayload(input: VerificationInput) {
  const failures: string[] = []
  const assetNames = new Set(input.release.assets.map((asset) => asset.name))

  if (input.release.draft) failures.push(`Release ${input.release.tag_name} is still a draft`)
  if (input.release.prerelease) failures.push(`Release ${input.release.tag_name} is marked as a prerelease`)

  for (const asset of REQUIRED_ASSETS) {
    if (!assetNames.has(asset)) failures.push(`Missing release asset: ${asset}`)
  }

  const latestUrls = input.latestYml === undefined ? [] : parseUpdaterFileUrls(input.latestYml)
  verifyReferencedAssets("latest.yml", latestUrls, assetNames, failures)
  if (!hasUpdaterEntry(latestUrls, "pawwork-win-x64.exe")) {
    failures.push("latest.yml does not include pawwork-win-x64.exe")
  }

  const latestMacUrls = input.latestMacYml === undefined ? [] : parseUpdaterFileUrls(input.latestMacYml)
  verifyReferencedAssets("latest-mac.yml", latestMacUrls, assetNames, failures)
  for (const asset of ["pawwork-mac-arm64.zip", "pawwork-mac-x64.zip"]) {
    if (!hasUpdaterEntry(latestMacUrls, asset)) failures.push(`latest-mac.yml does not include ${asset}`)
  }

  if (input.startupLog !== undefined) failures.push(...verifyStartupLog(input.startupLog, input.release.tag_name))

  return failures
}

export function normalizeTag(raw: string) {
  const normalized = raw.startsWith("v") ? raw : `v${raw}`
  if (!/^v\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Invalid release tag: ${raw}. Expected vX.Y.Z or X.Y.Z.`)
  }
  return normalized
}

function githubHeaders() {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  })
  if (process.env.GH_TOKEN) headers.set("Authorization", `Bearer ${process.env.GH_TOKEN}`)
  return headers
}

export async function fetchText(url: string) {
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(formatFetchError("fetch", url, response))
  return response.text()
}

export async function fetchJson<T>(url: string) {
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(formatFetchError("fetch", url, response))

  try {
    return (await response.json()) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse JSON from ${url}: ${message}`)
  }
}

export async function readStartupLogFile(path: string) {
  try {
    return await Bun.file(path).text()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read startup log file ${path}: ${message}`)
  }
}

async function fetchWithTimeout(url: string) {
  try {
    return await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to fetch ${url}: ${message}`)
  }
}

function formatFetchError(operation: string, url: string, response: Response) {
  const rateRemaining = response.headers.get("x-ratelimit-remaining")
  const rateReset = response.headers.get("x-ratelimit-reset")
  const rateInfo =
    rateRemaining === null ? "" : `, rate limit remaining: ${rateRemaining}${rateReset ? `, reset: ${rateReset}` : ""}`
  return `Failed to ${operation} ${url}: ${response.status} ${response.statusText}${rateInfo}`
}

function findAsset(release: GithubRelease, name: string) {
  return release.assets.find((entry) => entry.name === name)
}

async function fetchAssetText(release: GithubRelease, name: string) {
  const asset = findAsset(release, name)
  if (!asset) return undefined
  return fetchText(asset.browser_download_url)
}

async function main() {
  try {
    const tag = process.argv[2]
    if (!tag) {
      console.error(
        "Usage: bun packages/desktop-electron/scripts/verify-release.ts <tag> [owner/repo] [env: PAWWORK_RELEASE_STARTUP_LOG=/path/to/main.log]",
      )
      process.exit(2)
    }

    const repo = process.argv[3] ?? DEFAULT_REPO
    const normalizedTag = normalizeTag(tag)
    if (!process.env.GH_TOKEN) {
      console.warn("GH_TOKEN is not set; GitHub API requests will use the lower unauthenticated rate limit.")
    }
    const release = await fetchJson<GithubRelease>(
      `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(normalizedTag)}`,
    )
    const latestYml = await fetchAssetText(release, "latest.yml")
    const latestMacYml = await fetchAssetText(release, "latest-mac.yml")
    const startupLogPath = process.env.PAWWORK_RELEASE_STARTUP_LOG
    const startupLog = startupLogPath ? await readStartupLogFile(startupLogPath) : undefined
    const failures = verifyReleasePayload({ release, latestYml, latestMacYml, startupLog })

    if (failures.length) {
      console.error(`Release verification failed for ${repo} ${normalizedTag}:`)
      for (const failure of failures) console.error(`- ${failure}`)
      process.exit(1)
    }

    console.log(`Release verification passed for ${repo} ${normalizedTag}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Release verification could not run: ${message}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
