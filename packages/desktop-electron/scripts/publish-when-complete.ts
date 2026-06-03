// Auto-publish the prod release once every target's assets and updater metadata
// have landed in the draft, then dispatch the R2 mirror. Runs at the tail of
// each finalize/full build, so the LAST target to complete flips the draft into
// a published release. Fail-safe: missing targets leave the draft untouched;
// only a complete, same-commit release is ever published.
//
// Why a dedicated script (not the by-tag verifier): a draft release is NOT
// reachable via GET /releases/tags/{tag} (it 404s), so we look it up through the
// list endpoint; and its assets must be downloaded via the asset API URL with an
// `application/octet-stream` Accept header, not browser_download_url.

import { normalizeTag, verifyReleasePayload, type GithubRelease } from "./verify-release"

const GITHUB_API = "https://api.github.com"
const FETCH_TIMEOUT_MS = 30_000

type ApiAsset = { name: string; url: string; browser_download_url: string }
type ApiRelease = GithubRelease & { id: number; assets: ApiAsset[] }

export type PublishDecision =
  | { kind: "publish"; reason: string }
  | { kind: "mirror-only"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "fail"; reason: string }

// Pure policy: decide what to do from the current release state. Kept free of
// I/O so it is unit-testable without GitHub.
export function decidePublishAction(args: {
  release: GithubRelease
  latestYml?: string
  latestMacYml?: string
  buildSha: string
  existingTagSha?: string
}): PublishDecision {
  const { release, latestYml, latestMacYml, buildSha, existingTagSha } = args

  // A prerelease is a bad state for this pipeline: fail loudly instead of
  // waiting forever for a "completion" that publishing would never reach.
  if (release.prerelease) {
    return { kind: "fail", reason: `release ${release.tag_name} is marked as a prerelease` }
  }

  // Completeness reuses the exact verifier logic; allowDraft so the draft state
  // itself is not counted as a failure here. Any failure now means a target's
  // assets/updater metadata are not in yet -> keep waiting (no-op, exit 0).
  const failures = verifyReleasePayload({ release, latestYml, latestMacYml }, { allowDraft: true })
  if (failures.length > 0) {
    return { kind: "wait", reason: `release incomplete, waiting for remaining targets: ${failures.join("; ")}` }
  }

  // Same-source gate: never let the published tag point at a commit other than
  // the one these assets were built from. If the tag already exists pointing
  // elsewhere, the targets were not built from a single commit -> refuse.
  if (existingTagSha && existingTagSha !== buildSha) {
    return {
      kind: "fail",
      reason: `tag ${release.tag_name} points at ${existingTagSha}, not the build commit ${buildSha}; refusing to publish mismatched sources`,
    }
  }

  if (release.draft) {
    return {
      kind: "publish",
      reason: "all release targets present; publishing and pinning the tag to the build commit",
    }
  }

  // Already published by an earlier run. GITHUB_TOKEN publishes do not fire the
  // release:published webhook, and an earlier mirror dispatch may have failed,
  // so re-dispatch the (idempotent, per-tag serialized) mirror to avoid a gap.
  return { kind: "mirror-only", reason: "release already published; ensuring the mirror is dispatched" }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function githubHeaders(accept: string) {
  const headers = new Headers({ Accept: accept, "X-GitHub-Api-Version": "2022-11-28" })
  const token = process.env.GH_TOKEN
  if (token) headers.set("Authorization", `Bearer ${token}`)
  return headers
}

async function ghFetch(url: string, accept: string) {
  try {
    return await fetch(url, { headers: githubHeaders(accept), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function fetchReleases(repo: string): Promise<ApiRelease[]> {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, "application/vnd.github+json")
  if (!res.ok) throw new Error(`failed to list releases: ${res.status} ${res.statusText}`)
  return (await res.json()) as ApiRelease[]
}

// Returns undefined when the asset is not in the release yet (a missing target,
// handled as "wait"); throws when the asset exists but cannot be downloaded (a
// tooling/network error that must fail the job rather than silently wait).
async function fetchAssetText(release: ApiRelease, name: string): Promise<string | undefined> {
  const asset = release.assets.find((entry) => entry.name === name)
  if (!asset) return undefined
  const res = await ghFetch(asset.url, "application/octet-stream")
  if (!res.ok) throw new Error(`failed to download ${name}: ${res.status} ${res.statusText}`)
  return res.text()
}

async function fetchTagSha(repo: string, tag: string): Promise<string | undefined> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`,
    "application/vnd.github+json",
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`failed to read tag ${tag}: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { object?: { sha?: string } }
  return body.object?.sha
}

async function gh(args: string[]) {
  const proc = Bun.spawn(["gh", ...args], { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`gh ${args.join(" ")} exited ${code}`)
}

async function dispatchMirror(repo: string, tag: string, ref: string) {
  await gh(["workflow", "run", "mirror-release-to-r2.yml", "--repo", repo, "--ref", ref, "-f", `tag=${tag}`])
}

async function main() {
  const repo = requireEnv("GH_REPO")
  const tag = normalizeTag(requireEnv("RELEASE_TAG"))
  const buildSha = requireEnv("BUILD_SHA")
  const mirrorRef = process.env.MIRROR_REF ?? "dev"

  const releases = await fetchReleases(repo)
  const release = releases.find((entry) => entry.tag_name === tag)
  if (!release) {
    console.error(`publish-when-complete: no release found for ${tag} among ${releases.length} releases`)
    process.exit(1)
  }

  const latestYml = await fetchAssetText(release, "latest.yml")
  const latestMacYml = await fetchAssetText(release, "latest-mac.yml")
  const existingTagSha = await fetchTagSha(repo, tag)

  const decision = decidePublishAction({ release, latestYml, latestMacYml, buildSha, existingTagSha })
  console.log(`publish-when-complete: ${decision.reason}`)

  switch (decision.kind) {
    case "fail":
      process.exit(1)
      return
    case "wait":
      return
    case "publish":
      await gh([
        "release",
        "edit",
        tag,
        "--repo",
        repo,
        "--target",
        buildSha,
        "--draft=false",
        "--latest",
        "--prerelease=false",
      ])
      await dispatchMirror(repo, tag, mirrorRef)
      return
    case "mirror-only":
      await dispatchMirror(repo, tag, mirrorRef)
      return
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`publish-when-complete failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
