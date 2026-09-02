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

export type DraftDecision =
  | { kind: "reuse"; reason: string }
  | { kind: "create"; reason: string }
  | { kind: "fail"; reason: string }

// Pure policy, so the split-tag guard is testable without GitHub. `releases` is
// the releases the tag resolves to (the list endpoint filtered by tag_name).
export function decideDraftAction(tag: string, releases: TaggedRelease[]): DraftDecision {
  if (releases.length > 1) return { kind: "fail", reason: duplicateReleasesMessage(tag, releases) }

  const existing = releases[0]
  if (!existing) return { kind: "create", reason: `no release for ${tag}; creating an empty draft to upload into` }

  return {
    kind: "reuse",
    reason: `reusing release ${existing.id} for ${tag} (${existing.draft ? "draft" : "published"})`,
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

async function main() {
  const repo = requireEnv("GH_REPO")
  const tag = normalizeTag(requireEnv("RELEASE_TAG"))
  const targetSha = requireEnv("RELEASE_TARGET_SHA")

  const decision = decideDraftAction(tag, await fetchReleasesByTag<TaggedRelease>(repo, tag))
  console.log(`ensure-release-draft: ${decision.reason}`)
  if (decision.kind === "fail") process.exit(1)
  if (decision.kind === "reuse") return

  // Two phases can reach the create at the same time. Whether ours succeeds or
  // loses to the other one, re-read and let the same policy judge the result:
  // one release is fine no matter who made it, two is the split we exist to
  // report. Notes stay empty — the release text is written into the draft by
  // hand before it is published.
  try {
    await gh(["release", "create", tag, "--repo", repo, "--draft", "--target", targetSha, "--notes", ""])
  } catch (error) {
    console.warn(`ensure-release-draft: create failed (${error instanceof Error ? error.message : String(error)})`)
  }

  const settled = decideDraftAction(tag, await fetchReleasesByTag<TaggedRelease>(repo, tag))
  if (settled.kind === "reuse") {
    console.log(`ensure-release-draft: ${settled.reason}`)
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
