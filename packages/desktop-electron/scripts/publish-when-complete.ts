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
// independent build runs — mac arm64/x64 finalize + win full — each with its own
// source commit). The verifier only checks file names and updater metadata, so a
// version could otherwise be published with mac and win installers built from
// DIFFERENT commits. We use the draft's `target_commitish` as a provenance
// ledger: electron-builder creates the draft with the branch name there and
// never rewrites an existing draft, so the first target pins it to its build
// commit and every later target refuses to publish unless its own commit matches.

import { normalizeTag, verifyReleasePayload, type GithubRelease } from "./verify-release"

const GITHUB_API = "https://api.github.com"
const FETCH_TIMEOUT_MS = 30_000
// Absorb GitHub read-after-write lag on the assets/metadata this target just
// uploaded, so the last target to finish does not see a stale "incomplete" view
// and leave the release a draft with no later run to retry the publish.
const WAIT_POLL_ATTEMPTS = 6
const WAIT_POLL_INTERVAL_MS = 5_000
const FULL_SHA = /^[0-9a-f]{40}$/

type ApiAsset = { name: string; url: string; browser_download_url: string }
type ApiRelease = GithubRelease & { id: number; assets: ApiAsset[] }

export type PublishDecision =
  | { kind: "publish"; reason: string }
  | { kind: "mirror-only"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "fail"; reason: string }

// Pure policy: decide what to do from the current release state. Kept free of
// I/O so it is unit-testable without GitHub. `recordedSha` is the build commit
// already claimed on the draft (normalized to a full SHA, or undefined when the
// draft is still unclaimed); `buildSha` is this target's build commit.
export function decidePublishAction(args: {
  release: GithubRelease
  latestYml?: string
  latestMacYml?: string
  buildSha: string
  recordedSha?: string
}): PublishDecision {
  const { release, latestYml, latestMacYml, buildSha, recordedSha } = args

  // A prerelease is a bad state for this pipeline: fail loudly instead of
  // waiting forever for a "completion" that publishing would never reach.
  if (release.prerelease) {
    return { kind: "fail", reason: `release ${release.tag_name} is marked as a prerelease` }
  }

  // Provenance gate, checked before completeness: if the draft was already
  // claimed by a different build commit, this target's assets came from a
  // divergent source. Refuse regardless of completeness so a mixed-source
  // release is never published (and a complete-but-mixed draft is never mirrored).
  if (recordedSha && recordedSha !== buildSha) {
    return {
      kind: "fail",
      reason: `release ${release.tag_name} was assembled from ${recordedSha}, but this target was built from ${buildSha}; refusing to publish a mixed-source release`,
    }
  }

  // Completeness reuses the exact verifier logic; allowDraft so the draft state
  // itself is not counted as a failure here. Any failure now means a target's
  // assets/updater metadata are not in yet -> keep waiting (no-op, exit 0).
  const failures = verifyReleasePayload({ release, latestYml, latestMacYml }, { allowDraft: true })
  if (failures.length > 0) {
    return { kind: "wait", reason: `release incomplete, waiting for remaining targets: ${failures.join("; ")}` }
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

// The build commit currently claimed on the draft, or undefined when the draft
// is unclaimed (electron-builder leaves the default branch name there).
export function recordedBuildSha(release: GithubRelease): string | undefined {
  const value = release.target_commitish
  return value && FULL_SHA.test(value) ? value : undefined
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
  const res = await ghFetch(asset.url, "application/octet-stream")
  if (!res.ok) throw new Error(`failed to download ${name}: ${res.status} ${res.statusText}`)
  return res.text()
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

// Re-read the release (and its updater metadata) and decide. Pulled out so the
// wait-poll can re-evaluate against fresh GitHub state on each attempt.
async function evaluate(repo: string, tag: string, buildSha: string): Promise<PublishDecision> {
  const release = await findRelease(repo, tag)
  const latestYml = await fetchAssetText(release, "latest.yml")
  const latestMacYml = await fetchAssetText(release, "latest-mac.yml")
  return decidePublishAction({ release, latestYml, latestMacYml, buildSha, recordedSha: recordedBuildSha(release) })
}

async function main() {
  const repo = requireEnv("GH_REPO")
  const tag = normalizeTag(requireEnv("RELEASE_TAG"))
  const buildSha = requireEnv("BUILD_SHA")
  const mirrorRef = process.env.MIRROR_REF ?? "dev"

  // Claim provenance up front: pin the still-unclaimed draft to this build's
  // commit so any later target built from a different commit is detected. If a
  // different commit already claimed it, fail now without publishing/mirroring.
  const initial = await findRelease(repo, tag)
  const recorded = recordedBuildSha(initial)
  if (recorded && recorded !== buildSha) {
    console.error(
      `publish-when-complete: release ${tag} was assembled from ${recorded}, but this target was built from ${buildSha}; refusing to publish a mixed-source release`,
    )
    process.exit(1)
  }
  if (!recorded && initial.draft) {
    await gh(["release", "edit", tag, "--repo", repo, "--target", buildSha])
  }

  for (let attempt = 1; ; attempt += 1) {
    const decision = await evaluate(repo, tag, buildSha)
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
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`publish-when-complete failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
