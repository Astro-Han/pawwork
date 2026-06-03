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
// SINGLE-SOURCE GUARD. The assets for one version are assembled across several
// independent, sometimes concurrent build runs (mac arm64/x64 finalize + win
// full), each with its own source commit. Installers carry only the version in
// their names, so the verifier alone cannot tell whether mac and win came from
// the same commit. Three layers, designed to fail closed:
//
//   1. Per-target marker. Each target uploads a distinct asset
//      `pawwork-<os>-<arch>-<version>.commit` holding {commit, sha512} — its
//      build commit and the content hash of the installer it produced. Distinct
//      cells per target (never a shared mutable field), so there is no claim
//      race: concurrent targets from different commits leave disagreeing markers
//      and no run ever sees "all agree".
//   2. Content anchor. Before publishing, every marker's recorded sha512 must
//      still be present in the current latest*.yml. A target rebuilt from another
//      commit produces a different installer hash, so a stale marker no longer
//      matches the metadata — catching a clobber that landed before this run read
//      the markers.
//   3. Seal + re-read. Right before the publish PATCH (the only draft->published
//      write), snapshot the installer asset URLs, settle briefly, re-read, and
//      refuse if any asset URL changed (electron-builder's overwrite DELETEs then
//      re-creates an asset, so a clobber always yields a new URL). The PATCH is
//      the last write — catching a clobber that lands during the publish window.
//
// Residual: GitHub offers no atomic compare-and-swap across assets, so the seal's
// re-read and the PATCH are still two statements. A mixed-source publish would
// require an asset to be clobbered, from a different commit, in the single HTTP
// round-trip between the final re-read and the PATCH — not reachable by the CI
// pipeline (electron-builder's overwrite takes seconds and changes the URL), only
// by a human manually racing the publisher. Eliminating even that would need the
// commit in the asset filenames (breaks the updater, the R2 mirror, and the
// website links) or a single orchestrated workflow.

import {
  normalizeTag,
  parseUpdaterShaByUrl,
  releaseAssetNames,
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
// Retry the marker create on a transient 422 already_exists (delete not yet
// visible / concurrent same-target run) so it never leaves a complete release
// stuck as a draft.
const MARKER_UPLOAD_ATTEMPTS = 4
const MARKER_UPLOAD_RETRY_MS = 2_000
// Settle between sealing the asset URLs and the final re-read, long enough for an
// in-flight overwrite (DELETE + re-upload) to land and change the URL.
const SEAL_SETTLE_MS = 8_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ApiAsset = { name: string; url: string; browser_download_url: string }
type ApiRelease = GithubRelease & { id: number; upload_url: string; assets: ApiAsset[] }

// A target's provenance: its build commit and the content hash(es) of the
// updater asset it produced.
export type ProvenanceMarker = { commit: string; sha512: string[] }

export type PublishDecision =
  | { kind: "publish"; reason: string }
  | { kind: "mirror-only"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "fail"; reason: string }

// Pure policy: decide what to do from the current release state. Kept free of
// I/O so it is unit-testable without GitHub. `provenance` maps each PRESENT
// marker asset name to its parsed marker; `expectedProvenance` is the full set
// of marker names a complete release must carry; `updaterSha512s` is every
// content hash currently in latest*.yml.
export function decidePublishAction(args: {
  release: GithubRelease
  latestYml?: string
  latestMacYml?: string
  buildSha: string
  provenance: Record<string, ProvenanceMarker>
  expectedProvenance: string[]
  updaterSha512s: string[]
}): PublishDecision {
  const { release, latestYml, latestMacYml, buildSha, provenance, expectedProvenance, updaterSha512s } = args

  // A prerelease is a bad state for this pipeline: fail loudly instead of
  // waiting forever for a "completion" that publishing would never reach.
  if (release.prerelease) {
    return { kind: "fail", reason: `release ${release.tag_name} is marked as a prerelease` }
  }

  // Provenance gate, checked before completeness: any present marker whose commit
  // differs from this target's means the release is being assembled from more
  // than one commit. Refuse regardless of completeness.
  const mismatched = Object.entries(provenance).filter(([, marker]) => marker.commit !== buildSha)
  if (mismatched.length > 0) {
    const detail = mismatched.map(([name, marker]) => `${name}=${marker.commit}`).join(", ")
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

  // Content anchor: every marker's recorded installer hash must still be in the
  // current metadata. A drift means an asset was rebuilt from another commit
  // after its marker was written -> mixed source, refuse.
  const known = new Set(updaterSha512s)
  const drifted = Object.entries(provenance).flatMap(([name, marker]) =>
    marker.sha512.filter((hash) => !known.has(hash)).map((hash) => `${name}:${hash}`),
  )
  if (drifted.length > 0) {
    return {
      kind: "fail",
      reason: `release ${release.tag_name} updater metadata no longer matches recorded build hashes (${drifted.join(", ")}); refusing to publish a mixed-source release`,
    }
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

async function deleteExistingAsset(repo: string, releaseId: number, name: string) {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/releases/${releaseId}/assets?per_page=100`, {
    accept: "application/vnd.github+json",
  })
  if (!res.ok) throw new Error(`failed to list assets for release ${releaseId}: ${res.status} ${res.statusText}`)
  const existing = ((await res.json()) as ApiAsset[]).find((entry) => entry.name === name)
  if (!existing) return
  const del = await ghFetch(existing.url, { method: "DELETE", accept: "application/vnd.github+json" })
  if (!del.ok && del.status !== 404) throw new Error(`failed to replace marker ${name}: ${del.status} ${del.statusText}`)
}

// Upload this target's provenance marker via the release upload_url (draft-safe:
// the by-tag asset endpoints 404 on drafts, the release id/upload_url do not).
// Asset names are unique per release, so we delete any same-named asset first.
// GitHub can still answer the create with 422 already_exists (delete not yet
// visible, or a concurrent same-target run); retry by re-deleting so a transient
// clash never leaves the release stuck as a complete-but-unpublished draft.
async function putProvenanceMarker(repo: string, release: ApiRelease, name: string, body: string) {
  const uploadBase = release.upload_url.replace(/\{[^}]*\}$/, "")
  for (let attempt = 1; ; attempt += 1) {
    await deleteExistingAsset(repo, release.id, name)
    const res = await ghFetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      accept: "application/vnd.github+json",
      contentType: "text/plain",
      body,
    })
    if (res.ok) return
    if (res.status === 422 && attempt < MARKER_UPLOAD_ATTEMPTS) {
      await sleep(MARKER_UPLOAD_RETRY_MS)
      continue
    }
    throw new Error(`failed to upload marker ${name}: ${res.status} ${res.statusText}`)
  }
}

function parseMarker(text: string): ProvenanceMarker | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (
      value &&
      typeof value === "object" &&
      typeof (value as ProvenanceMarker).commit === "string" &&
      Array.isArray((value as ProvenanceMarker).sha512) &&
      (value as ProvenanceMarker).sha512.every((entry) => typeof entry === "string")
    ) {
      const marker = value as ProvenanceMarker
      return { commit: marker.commit, sha512: marker.sha512 }
    }
  } catch {
    // Malformed marker: treat as not-yet-present (handled as "wait"), never as a
    // valid provenance claim, so a corrupt marker can never gate a publish open.
  }
  return undefined
}

async function readProvenance(release: ApiRelease, expected: string[]): Promise<Record<string, ProvenanceMarker>> {
  const entries: Record<string, ProvenanceMarker> = {}
  for (const name of expected) {
    const text = await fetchAssetText(release, name)
    if (text === undefined) continue
    const marker = parseMarker(text)
    if (marker) entries[name] = marker
  }
  return entries
}

function updaterSha512sFrom(latestYml?: string, latestMacYml?: string): string[] {
  return [latestYml, latestMacYml].filter((yml): yml is string => yml !== undefined).flatMap((yml) =>
    parseUpdaterShaByUrl(yml).map((entry) => entry.sha512),
  )
}

// URLs of the installer/metadata assets (each embeds the asset id), keyed by
// name. A clobber DELETEs and re-creates an asset, so a changed URL signals a
// rebuild between the seal and the publish.
function sealAssetUrls(release: ApiRelease, version: string): Map<string, string> {
  const tracked = new Set(releaseAssetNames(version))
  const urls = new Map<string, string>()
  for (const asset of release.assets) {
    if (tracked.has(asset.name)) urls.set(asset.name, asset.url)
  }
  return urls
}

function changedAssets(sealed: Map<string, string>, current: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [name, url] of sealed) {
    if (current.get(name) !== url) changed.push(name)
  }
  return changed
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

// The updater asset (the file electron-updater downloads) and its metadata file,
// per OS. Its content hash is what the marker records for the content anchor.
function targetUpdater(os: string): { ext: string; metadata: "latest.yml" | "latest-mac.yml" } {
  return os === "win" ? { ext: "exe", metadata: "latest.yml" } : { ext: "zip", metadata: "latest-mac.yml" }
}

async function readEvaluationState(repo: string, tag: string, expectedProvenance: string[]) {
  const release = await findRelease(repo, tag)
  const latestYml = await fetchAssetText(release, "latest.yml")
  const latestMacYml = await fetchAssetText(release, "latest-mac.yml")
  const provenance = await readProvenance(release, expectedProvenance)
  return { release, latestYml, latestMacYml, provenance }
}

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

  // Record this target's build commit AND the hash of the installer it produced,
  // before deciding, so other targets can detect both a different commit and a
  // later clobber of this target's asset.
  const release = await findRelease(repo, tag)
  const { ext, metadata } = targetUpdater(os)
  const myUpdaterAsset = `pawwork-${os}-${arch}-${version}.${ext}`
  const myYml = await fetchAssetText(release, metadata)
  const myEntry = myYml ? parseUpdaterShaByUrl(myYml).find((entry) => entry.name === myUpdaterAsset) : undefined
  const marker: ProvenanceMarker = { commit: buildSha, sha512: myEntry ? [myEntry.sha512] : [] }
  await putProvenanceMarker(repo, release, thisMarker, JSON.stringify(marker))

  for (let attempt = 1; ; attempt += 1) {
    const state = await readEvaluationState(repo, tag, expectedProvenance)
    const decision = decidePublishAction({
      release: state.release,
      latestYml: state.latestYml,
      latestMacYml: state.latestMacYml,
      buildSha,
      provenance: state.provenance,
      expectedProvenance,
      updaterSha512s: updaterSha512sFrom(state.latestYml, state.latestMacYml),
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
      case "publish": {
        // Seal + re-read: snapshot the asset URLs, let any in-flight overwrite
        // land, then re-evaluate. Publish only if the release is STILL a
        // complete, single-source publish AND no tracked asset URL moved — the
        // PATCH is the final write.
        const sealed = sealAssetUrls(state.release, version)
        await sleep(SEAL_SETTLE_MS)
        const reread = await readEvaluationState(repo, tag, expectedProvenance)
        const recheck = decidePublishAction({
          release: reread.release,
          latestYml: reread.latestYml,
          latestMacYml: reread.latestMacYml,
          buildSha,
          provenance: reread.provenance,
          expectedProvenance,
          updaterSha512s: updaterSha512sFrom(reread.latestYml, reread.latestMacYml),
        })
        if (recheck.kind !== "publish") {
          console.error(`publish-when-complete: release changed during seal, not publishing: ${recheck.reason}`)
          if (recheck.kind === "fail") process.exit(1)
          return
        }
        const moved = changedAssets(sealed, sealAssetUrls(reread.release, version))
        if (moved.length > 0) {
          console.error(
            `publish-when-complete: release assets changed during seal (${moved.join(", ")}); refusing to publish a possibly mixed-source release`,
          )
          process.exit(1)
        }
        await publishRelease(repo, reread.release, buildSha)
        await dispatchMirror(repo, tag, mirrorRef)
        return
      }
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
