export type GithubAsset = {
  name: string
  // The API asset endpoint, used with an octet-stream Accept header. Distinct
  // from browser_download_url, which redirects and drops the auth header.
  url: string
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
  // Keyed by metadata file, so a fourth target with a new one is verified by
  // the same loop that already downloads and mirrors it. Absent means the
  // caller did not fetch it; empty string would mean it is there and empty.
  metadata?: Partial<Record<MetadataFile, string>>
}

const DEFAULT_REPO = `${PAWWORK_RELEASE_OWNER}/${PAWWORK_APP.prod.releaseRepo}`
const FETCH_TIMEOUT_MS = 15_000

export function releaseAssetNames(version: string) {
  return [
    ...new Set([
      ...RELEASE_TARGETS.flatMap((target) => [
        releaseAssetName(target, version, target.installerExt),
        releaseAssetName(target, version, target.updaterExt),
        `${releaseAssetName(target, version, target.updaterExt)}.blockmap`,
      ]),
      ...METADATA_FILES,
    ]),
  ]
}

// Per-target build-provenance marker. Each build target uploads one of these
// (containing its build commit) so the auto-publisher can confirm every target
// of a release was built from the same commit before publishing. One distinct
// asset per target — never a shared mutable field — so concurrent targets cannot
// race on it. Not part of releaseAssetNames, so the R2 mirror never copies them.
export function releaseProvenanceAssetName(os: string, arch: string, version: string) {
  return `pawwork-${os}-${arch}-${version}.commit`
}

export function releaseProvenanceAssetNames(version: string) {
  return RELEASE_TARGETS.map((target) => releaseProvenanceAssetName(target.os, target.arch, version))
}

export function releaseUpdaterAssetNames(version: string): Record<MetadataFile, string[]> {
  return Object.fromEntries(
    METADATA_FILES.map((metadata) => [
      metadata,
      RELEASE_TARGETS.filter((target) => target.metadata === metadata).map((target) =>
        releaseAssetName(target, version, target.updaterExt),
      ),
    ]),
  ) as Record<MetadataFile, string[]>
}

export function parseUpdaterFileUrls(source: string) {
  const metadata = parseUpdaterMetadata(source)
  return [...metadata.files.map((file) => file.url), ...(metadata.path === undefined ? [] : [metadata.path])]
}

export function parseUpdaterVersion(source: string) {
  return parseUpdaterMetadata(source).version
}

// Pair each updater file entry with its content sha512, keyed by asset basename.
// Used by the auto-publisher's single-source guard: a marker records the sha512
// the target produced, and publishing requires it to still match the metadata —
// so an asset rebuilt from another commit (different hash) is caught. Same
// deliberately-narrow scanner as parseUpdaterFileUrls; ignores the top-level
// `sha512:` (the `path:` digest), which has no preceding `- url:` entry.
export function parseUpdaterShaByUrl(source: string): Array<{ name: string; sha512: string }> {
  return parseUpdaterMetadata(source).files.flatMap((file) =>
    file.sha512 === undefined ? [] : [{ name: assetNameFromUrl(file.url), sha512: file.sha512 }],
  )
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

function verifyUpdaterVersion(sourceName: string, source: string | undefined, expected: string, failures: string[]) {
  if (source === undefined) return
  const actual = parseUpdaterVersion(source)
  if (actual === undefined) failures.push(`${sourceName} does not declare version ${expected}`)
  else if (actual !== expected) failures.push(`${sourceName} version ${actual} does not match release ${expected}`)
}

function releaseVersion(tag: string) {
  return normalizeTag(tag).slice(1)
}

export function verifyReleasePayload(input: VerificationInput, options?: { allowDraft?: boolean }) {
  const failures: string[] = []
  const assetNames = new Set(input.release.assets.map((asset) => asset.name))
  let version: string | undefined
  try {
    version = releaseVersion(input.release.tag_name)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }

  if (input.release.draft && !options?.allowDraft) failures.push(`Release ${input.release.tag_name} is still a draft`)
  if (input.release.prerelease) failures.push(`Release ${input.release.tag_name} is marked as a prerelease`)

  const urls = new Map(
    METADATA_FILES.map((metadata) => {
      const source = input.metadata?.[metadata]
      const parsed = source === undefined ? [] : parseUpdaterFileUrls(source)
      verifyReferencedAssets(metadata, parsed, assetNames, failures)
      return [metadata, parsed]
    }),
  )

  if (version) {
    const updaterAssets = releaseUpdaterAssetNames(version)
    for (const metadata of METADATA_FILES) {
      verifyUpdaterVersion(metadata, input.metadata?.[metadata], version, failures)
      for (const asset of updaterAssets[metadata]) {
        if (!hasUpdaterEntry(urls.get(metadata)!, asset)) failures.push(`${metadata} does not include ${asset}`)
      }
    }
    for (const asset of releaseAssetNames(version)) {
      if (!assetNames.has(asset)) failures.push(`Missing release asset: ${asset}`)
    }
  }

  return failures
}

export function normalizeTag(raw: string) {
  const normalized = raw.startsWith("v") ? raw : `v${raw}`
  if (!/^v\d{4}\.\d{1,2}\.\d{1,2}$/.test(normalized)) {
    throw new Error(`Invalid release tag: ${raw}. Expected vYYYY.M.D or YYYY.M.D.`)
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
        "Usage: pnpm --filter @pawwork/desktop exec tsx scripts/verify-release.ts <tag> [owner/repo]",
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
    const metadata = Object.fromEntries(
      await Promise.all(METADATA_FILES.map(async (name) => [name, await fetchAssetText(release, name)] as const)),
    )
    const failures = verifyReleasePayload({ release, metadata })

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
import { parseUpdaterMetadata } from "./updater-metadata"
import {
  METADATA_FILES,
  RELEASE_TARGETS,
  releaseAssetName,
  type MetadataFile,
} from "./release-targets"
import { PAWWORK_APP, PAWWORK_RELEASE_OWNER } from "../src/main/app-identity.ts"
