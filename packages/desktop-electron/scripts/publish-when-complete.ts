// Auto-publish the prod release once every target's assets and updater metadata
// have landed in the draft, then dispatch the R2 mirror. Runs at the tail of
// each finalize/full build, so the LAST target to complete flips the draft into
// a published release. Fail-safe: missing targets leave the draft untouched;
// only a complete, single-source release is ever published.
//
// Why a dedicated script (not the by-tag verifier): a draft release is NOT
// reachable via GET /releases/tags/{tag} (it 404s), so we look it up through the
// list endpoint; and its assets must be downloaded via the asset API URL with an
// `application/octet-stream` Accept header, not browser_download_url.
//
// Single-source guard (the assets for one version are assembled across several
// independent, sometimes concurrent build runs — mac arm64/x64 finalize + win
// full — each with its own source commit). The installers carry only the version
// in their names, so the verifier alone cannot tell whether mac and win were
// built from the same commit. Each target therefore uploads a small per-target
// provenance marker (`pawwork-<os>-<arch>-<version>.commit`) holding its build
// commit. The publisher publishes only when EVERY expected marker is present and
// they all agree. Because each target writes its own distinct marker — never a
// shared mutable field — there is no claim race: concurrent targets built from
// different commits leave disagreeing markers, and no run ever sees "all agree".

import {
  normalizeTag,
  releaseProvenanceAssetName,
  releaseProvenanceAssetNames,
  verifyReleasePayload,
  type GithubRelease,
} from "./verify-release"

const GITHUB_API = "https://api.github.com"
const FETCH_TIMEOUT_MS = 30_000
// Absorb GitHub read-after-write lag on the assets/metadata this target just
// uploaded, so the last target to finish does not see a stale "incomplete" view
// and leave the release a draft with no later run to retry the publish.
const WAIT_POLL_ATTEMPTS = 6
const WAIT_POLL_INTERVAL_MS = 5_000

type ApiAsset = { name: string; url: string; browser_download_url: string }
type ApiRelease = GithubRelease & { id: number; upload_url: string; assets: ApiAsset[] }

export type PublishDecision =
  | { kind: "publish"; reason: string }
  | { kind: "mirror-only"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "fail"; reason: string }

// Pure policy: decide what to do from the current release state. Kept free of
// I/O so it is unit-testable without GitHub. `provenance` maps each PRESENT
// marker asset name to the build commit it records; `expectedProvenance` is the
// full set of marker names a complete release must carry.
export function decidePublishAction(args: {
  release: GithubRelease
  latestYml?: string
  latestMacYml?: string
  buildSha: string
  provenance: Record<string, string>
  expectedProvenance: string[]
}): PublishDecision {
  const { release, latestYml, latestMacYml, buildSha, provenance, expectedProvenance } = args

  // A prerelease is a bad state for this pipeline: fail loudly instead of
  // waiting forever for a "completion" that publishing would never reach.
  if (release.prerelease) {
    return { kind: "fail", reason: `release ${release.tag_name} is marked as a prerelease` }
  }

  // Provenance gate, checked before completeness: any present marker that does
  // not match this target's build commit means the release is being assembled
  // from more than one commit. Refuse regardless of completeness, so a
  // mixed-source draft is never published (or mirrored).
  const mismatched = Object.entries(provenance).filter(([, sha]) => sha !== buildSha)
  if (mismatched.length > 0) {
    const detail = mismatched.map(([name, sha]) => `${name}=${sha}`).join(", ")
    return {
      kind: "fail",
      reason: `release ${release.tag_name} has targets built from different commits (this target ${buildSha}; ${detail}); refusing to publish a mixed-source release`,
    }
  }

  // Completeness: every installer + updater metadata (the verifier) AND every
  // per-target provenance marker must be present. Any gap means a target has not
  // finished yet -> keep waiting (no-op, exit 0). allowDraft so the draft state
  // itself is not counted as a failure here.
  const failures = verifyReleasePayload({ release, latestYml, latestMacYml }, { allowDraft: true })
  const missingMarkers = expectedProvenance.filter((name) => !(name in provenance))
  if (failures.length > 0 || missingMarkers.length > 0) {
    const reasons = [...failures, ...missingMarkers.map((name) => `missing provenance marker ${name}`)]
    return { kind: "wait", reason: `release incomplete, waiting for remaining targets: ${reasons.join("; ")}` }
  }

  if (release.draft) {
    return {
      kind: "publish",
      reason: "all release targets present and single-source; publishing and pinning the tag to the build commit",
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

function githubHeaders(accept: string, contentType?: string) {
  const headers = new Headers({ Accept: accept, "X-GitHub-Api-Version": "2022-11-28" })
  const token = process.env.GH_TOKEN
  if (token) headers.set("Authorization", `Bearer ${token}`)
  if (contentType) headers.set("Content-Type", contentType)
  return headers
}

async function ghFetch(url: string, init: RequestInit & { accept: string; contentType?: string }) {
  const { accept, contentType, ...rest } = init
  try {
    return await fetch(url, {
      ...rest,
      headers: githubHeaders(accept, contentType),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function fetchReleases(repo: string): Promise<ApiRelease[]> {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, { accept: "application/vnd.github+json" })
  if (!res.ok) throw new Error(`failed to list releases: ${res.status} ${res.statusText}`)
  return (await res.json()) as ApiRelease[]
}

async function findRelease(repo: string, tag: string): Promise<ApiRelease> {
  const releases = await fetchReleases(repo)
  const release = releases.find((entry) => entry.tag_name === tag)
  if (!release) throw new Error(`no release found for ${tag} among ${releases.length} releases`)
  return release
}

// Returns undefined when the asset is not in the release yet (a missing target,
// handled as "wait"); throws when the asset exists but cannot be downloaded (a
// tooling/network error that must fail the job rather than silently wait).
async function fetchAssetText(release: ApiRelease, name: string): Promise<string | undefined> {
  const asset = release.assets.find((entry) => entry.name === name)
  if (!asset) return undefined
  const res = await ghFetch(asset.url, { accept: "application/octet-stream" })
  if (!res.ok) throw new Error(`failed to download ${name}: ${res.status} ${res.statusText}`)
  return res.text()
}

// Upload this target's provenance marker via the release upload_url (draft-safe:
// the by-tag asset endpoints 404 on drafts, the release id/upload_url do not).
// Delete any existing same-named asset first so a re-run overwrites cleanly.
async function putProvenanceMarker(repo: string, release: ApiRelease, name: string, sha: string) {
  const existing = release.assets.find((entry) => entry.name === name)
  if (existing) {
    const del = await ghFetch(existing.url, { method: "DELETE", accept: "application/vnd.github+json" })
    if (!del.ok && del.status !== 404) throw new Error(`failed to replace marker ${name}: ${del.status} ${del.statusText}`)
  }
  const uploadBase = release.upload_url.replace(/\{[^}]*\}$/, "")
  const res = await ghFetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    accept: "application/vnd.github+json",
    contentType: "text/plain",
    body: sha,
  })
  if (!res.ok) throw new Error(`failed to upload marker ${name}: ${res.status} ${res.statusText}`)
}

async function readProvenance(release: ApiRelease, expected: string[]): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const name of expected) {
    const text = await fetchAssetText(release, name)
    if (text !== undefined) entries[name] = text.trim()
  }
  return entries
}

// Publish via the release id (draft-safe: the by-tag edit endpoints can fail to
// resolve drafts), pinning the tag to the agreed build commit and marking it
// latest. A GITHUB_TOKEN publish does not fire release:published, so the caller
// still dispatches the mirror explicitly.
async function publishRelease(repo: string, release: ApiRelease, buildSha: string) {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/releases/${release.id}`, {
    method: "PATCH",
    accept: "application/vnd.github+json",
    contentType: "application/json",
    body: JSON.stringify({ draft: false, prerelease: false, make_latest: "true", target_commitish: buildSha }),
  })
  if (!res.ok) throw new Error(`failed to publish ${release.tag_name}: ${res.status} ${res.statusText}`)
}

async function gh(args: string[]) {
  const proc = Bun.spawn(["gh", ...args], { stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`gh ${args.join(" ")} exited ${code}`)
}

async function dispatchMirror(repo: string, tag: string, ref: string) {
  await gh(["workflow", "run", "mirror-release-to-r2.yml", "--repo", repo, "--ref", ref, "-f", `tag=${tag}`])
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const repo = requireEnv("GH_REPO")
  const tag = normalizeTag(requireEnv("RELEASE_TAG"))
  const buildSha = requireEnv("BUILD_SHA")
  const os = requireEnv("RELEASE_OS")
  const arch = requireEnv("RELEASE_ARCH")
  const mirrorRef = process.env.MIRROR_REF ?? "dev"

  const version = tag.replace(/^v/, "")
  const expectedProvenance = releaseProvenanceAssetNames(version)
  const thisMarker = releaseProvenanceAssetName(os, arch, version)

  // Record this target's build commit before deciding, so any other target
  // built from a different commit will find a disagreeing marker.
  const release = await findRelease(repo, tag)
  await putProvenanceMarker(repo, release, thisMarker, buildSha)

  for (let attempt = 1; ; attempt += 1) {
    const current = await findRelease(repo, tag)
    const latestYml = await fetchAssetText(current, "latest.yml")
    const latestMacYml = await fetchAssetText(current, "latest-mac.yml")
    const provenance = await readProvenance(current, expectedProvenance)
    const decision = decidePublishAction({
      release: current,
      latestYml,
      latestMacYml,
      buildSha,
      provenance,
      expectedProvenance,
    })
    console.log(`publish-when-complete (attempt ${attempt}/${WAIT_POLL_ATTEMPTS}): ${decision.reason}`)

    if (decision.kind === "wait" && attempt < WAIT_POLL_ATTEMPTS) {
      await sleep(WAIT_POLL_INTERVAL_MS)
      continue
    }

    switch (decision.kind) {
      case "fail":
        process.exit(1)
        return
      case "wait":
        return
      case "publish":
        await publishRelease(repo, current, buildSha)
        await dispatchMirror(repo, tag, mirrorRef)
        return
      case "mirror-only":
        await dispatchMirror(repo, tag, mirrorRef)
        return
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`publish-when-complete failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
