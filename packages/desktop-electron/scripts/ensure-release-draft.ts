// Guarantee exactly one release exists for the tag BEFORE electron-builder
// starts uploading. electron-builder uploads a target's assets concurrently and
// each upload creates the release when it is missing, so a first-to-publish
// phase can end up with two drafts for one tag, assets split between them, and a
// checksum failure much later that says nothing about the split.
//
// Idempotent and safe to run from every phase: one existing release is reused,
// none is created. Two or more is a release-process error, not something to
// choose between, so it fails fast and names the split.

import { spawn } from "node:child_process"

import { duplicateReleasesMessage, fetchReleasesByTag, normalizeTag, type GithubRelease } from "./verify-release"

type TaggedRelease = GithubRelease & { id: number }

// Spread the creates of phases that start together, so the common case is one
// job creating and the others simply seeing its release.
const CREATE_JITTER_MS = 3_000
// The list endpoint lags a create, so a second read taken immediately can miss
// the other job's release and let both conclude they are alone. Same settle
// window publish-when-complete uses before its final re-read.
const CREATE_SETTLE_MS = 8_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type DraftDecision =
  | { kind: "reuse"; reason: string; published: boolean }
  | { kind: "create"; reason: string }
  | { kind: "fail"; reason: string }

// Pure policy, so the split-tag guard is testable without GitHub. `releases` is
// the releases the tag resolves to (the list endpoint filtered by tag_name).
export function decideDraftAction(tag: string, releases: TaggedRelease[]): DraftDecision {
  if (releases.length > 1) return { kind: "fail", reason: duplicateReleasesMessage(tag, releases) }

  const existing = releases[0]
  if (!existing) return { kind: "create", reason: `no release for ${tag}; creating an empty draft to upload into` }

  if (existing.draft) return { kind: "reuse", reason: `reusing draft ${existing.id} for ${tag}`, published: false }

  return {
    kind: "reuse",
    reason: `release ${existing.id} for ${tag} is already published; uploading into a live release, not a draft`,
    published: true,
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function gh(args: string[]) {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("gh", args, { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", resolve)
  })
  if (code !== 0) throw new Error(`gh ${args.join(" ")} exited ${code}`)
}

function report(decision: DraftDecision) {
  // A published release means the assets are about to be uploaded to something
  // that is already live, not to a draft this run controls. Legitimate on a
  // re-run, worth saying out loud either way.
  if (decision.kind === "reuse" && decision.published) console.warn(`ensure-release-draft: ${decision.reason}`)
  else console.log(`ensure-release-draft: ${decision.reason}`)
}

async function main() {
  const repo = requireEnv("GH_REPO")
  // Anonymous list requests cannot see drafts, so a missing token would make
  // every run believe the tag has no release and create a second one.
  requireEnv("GH_TOKEN")
  const tag = normalizeTag(requireEnv("RELEASE_TAG"))
  const targetSha = requireEnv("RELEASE_TARGET_SHA")

  const decision = decideDraftAction(tag, await fetchReleasesByTag<TaggedRelease>(repo, tag))
  report(decision)
  if (decision.kind === "fail") process.exit(1)
  if (decision.kind === "reuse") return

  // Two phases can reach the create at the same time. Jitter first so they
  // usually do not, then create, then let the list endpoint catch up before
  // re-reading: reading it immediately can still show only our own release and
  // leave both jobs believing they are the only one. Whether our create won or
  // lost, the same policy judges the settled result — one release is fine no
  // matter who made it, two is the split we exist to report. Notes stay empty;
  // the release text is written into the draft by hand before it is published.
  await sleep(Math.random() * CREATE_JITTER_MS)
  try {
    await gh(["release", "create", tag, "--repo", repo, "--draft", "--target", targetSha, "--notes", ""])
  } catch (error) {
    console.warn(`ensure-release-draft: create failed (${error instanceof Error ? error.message : String(error)})`)
  }
  await sleep(CREATE_SETTLE_MS)

  const settled = decideDraftAction(tag, await fetchReleasesByTag<TaggedRelease>(repo, tag))
  if (settled.kind === "reuse") {
    report(settled)
    return
  }
  console.error(
    `ensure-release-draft: ${settled.kind === "fail" ? settled.reason : `still no release for ${tag} after creating one`}`,
  )
  process.exit(1)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ensure-release-draft failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
