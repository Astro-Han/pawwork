// Mirror a published GitHub Release's installers to Cloudflare R2 so the China
// landing page (site/) can serve fast, CDN-cached direct downloads.
//
// Ordering matters (see PR discussion): versioned installer objects are
// immutable and uploaded first; the mutable pointers — the electron-updater
// latest*.yml and finally the landing page's latest.json — are written last,
// so a failure leaves the site pointing at the previous good release rather
// than a half-mirrored one. Run AFTER verify-release.ts has confirmed the
// release is complete.
//
// Usage: pnpm --filter @pawwork/desktop exec tsx scripts/mirror-release-to-r2.ts <tag> [owner/repo]
// Env:
//   R2_ACCOUNT_ID            Cloudflare account id (S3 endpoint host)
//   R2_BUCKET                target bucket, e.g. pawwork-downloads
//   DOWNLOAD_PUBLIC_BASE     public base URL, e.g. https://dl.pawwork.ai
//   AWS_ACCESS_KEY_ID        R2 token access key (S3-compatible)
//   AWS_SECRET_ACCESS_KEY    R2 token secret
//   GH_TOKEN                 GitHub token for `gh release download`

import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { gt } from "semver"
import { parseUpdaterFileUrls, parseUpdaterVersion, releaseAssetNames } from "./verify-release.ts"
import { METADATA_FILES, RELEASE_TARGETS, releaseAssetName, releaseTarget, type ReleaseTarget } from "./release-targets"

// The updater pointers are the only mutable objects in the mirror: everything
// else is versioned and cached for a year. A metadata file this set missed
// would be uploaded immutable, and the updater would read a year-old pointer.
const MUTABLE_POINTERS = new Set<string>(METADATA_FILES)
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
const POINTER_CACHE = "no-cache, must-revalidate"
const MANIFEST_NAME = "latest.json"
const RETENTION_POINTERS = ["latest-mac.yml", "latest.yml", ...METADATA_FILES, MANIFEST_NAME]
const execFileAsync = promisify(execFile)

export type UploadStep = { name: string; cacheControl: string; manifest?: boolean }

// Pointer object the landing page reads to swap download buttons to R2 links.
// Keys match the data-dl attributes on the buttons in site/src/pages/index.astro.
export function buildManifest(
  version: string,
  publicBase: string,
): { version: string } & Record<ReleaseTarget["manifestKey"], string> {
  const base = publicBase.replace(/\/$/, "")
  return {
    version,
    ...(Object.fromEntries(
      RELEASE_TARGETS.map((target) => [
        target.manifestKey,
        `${base}/${releaseAssetName(target, version, target.installerExt)}`,
      ]),
    ) as Record<ReleaseTarget["manifestKey"], string>),
  }
}

// Ordered upload plan: immutable versioned artifacts first, then the mutable
// electron-updater pointers, then the landing-page manifest LAST — the single
// switch that makes a release live. The order is load-bearing (a half-mirror
// must never point the site at incomplete artifacts); locked by the test.
export function uploadPlan(assets: string[]): UploadStep[] {
  const versioned = assets
    .filter((name) => !MUTABLE_POINTERS.has(name))
    .map((name) => ({ name, cacheControl: IMMUTABLE_CACHE }))
  const pointers = assets
    .filter((name) => MUTABLE_POINTERS.has(name))
    .map((name) => ({ name, cacheControl: POINTER_CACHE }))
  return [...versioned, ...pointers, { name: MANIFEST_NAME, cacheControl: POINTER_CACHE, manifest: true }]
}

// The bare asset names a latest*.yml points electron-updater at. The generic R2
// feed resolves these relative to dl.pawwork.ai, so each must be an object we
// actually mirror — otherwise the in-app updater (#219) downloads a 404.
export function pointerReferencedAssets(pointerYml: string): string[] {
  return [...new Set(parseUpdaterFileUrls(pointerYml).map((url) => url.split("/").at(-1) ?? url))]
}

export function missingPointerReferences(referenced: string[], mirrored: Set<string>): string[] {
  return referenced.filter((name) => !mirrored.has(name))
}

type MirrorObject = { Key: string; Size: number }

// The v1 and v2 feeds own retention. Historical blockmaps remain available to
// clients updating from older versions; GitHub owns the full release archive.
export function cleanupPlan(objects: MirrorObject[], pointers: Record<string, string>, publicBase: string): string[] {
  for (const name of RETENTION_POINTERS) {
    if (!pointers[name]) throw new Error(`Missing retention pointer: ${name}`)
  }
  const present = new Set(objects.filter((object) => object.Size > 0).map((object) => object.Key))
  const versions = [
    ["latest-mac.yml", "latest.yml"],
    METADATA_FILES,
  ].map((channel) => {
    const version = parseUpdaterVersion(pointers[channel[0]])
    if (!version || !/^\d{4}\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version in ${channel[0]}`)
    const assets = new Set(releaseAssetNames(version).filter((name) => name.startsWith("pawwork-")))
    for (const name of channel) {
      if (parseUpdaterVersion(pointers[name]) !== version) throw new Error(`Channel version mismatch: ${name}`)
      const refs = pointerReferencedAssets(pointers[name])
      const targets = RELEASE_TARGETS.filter((target) => name.includes("-mac.") ? target.os === "mac" : target.os === "win")
      if (refs.some((ref) => !assets.has(ref)) || targets.some((target) =>
        !refs.includes(releaseAssetName(target, version, target.updaterExt)))) {
        throw new Error(`Invalid retention references: ${name}`)
      }
    }
    const missing = missingPointerReferences([...assets], present)
    if (missing.length) throw new Error(`Incomplete retained release: ${missing.join(", ")}`)
    return version
  })
  const manifest = JSON.parse(pointers[MANIFEST_NAME])
  const expected = buildManifest(versions[1], publicBase)
  if (!manifest || Object.entries(expected).some(([key, value]) => manifest[key] !== value)) {
    throw new Error("latest.json does not match the v2 update channel")
  }
  const retained = new Set(versions.flatMap((version) => releaseAssetNames(version)))
  return objects.map((object) => object.Key).filter((name) => {
    if (retained.has(name)) return false
    const match = name.match(/^pawwork-(?:mac-(?:arm64|x64)|win-x64)-(\d{4}\.\d+\.\d+)\.(?:dmg|zip|exe)$/)
    return match !== null && releaseAssetNames(match[1]).includes(name)
  }).sort()
}

const CONTENT_TYPES: Record<string, string> = {
  dmg: "application/x-apple-diskimage",
  exe: "application/octet-stream",
  zip: "application/zip",
  yml: "text/yaml",
  json: "application/json",
  blockmap: "application/octet-stream",
}

function contentTypeFor(name: string) {
  const ext = name.split(".").pop() ?? ""
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env: ${key}`)
  return value
}

async function run(cmd: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd[0], cmd.slice(1))
  return stdout
}

async function main() {
  const tag = process.argv[2]
  const cleanupOnly = tag === "--cleanup-only"
  const dryRun = cleanupOnly && process.argv[3] === "--dry-run"
  if (!tag || (cleanupOnly && process.argv[3] !== undefined && !dryRun)) {
    console.error("Usage: mirror-release-to-r2.ts <tag> [owner/repo] | --cleanup-only [--dry-run]")
    process.exit(1)
  }
  const accountId = requireEnv("R2_ACCOUNT_ID")
  const bucket = requireEnv("R2_BUCKET")
  const publicBase = requireEnv("DOWNLOAD_PUBLIC_BASE").replace(/\/$/, "")
  requireEnv("AWS_ACCESS_KEY_ID")
  requireEnv("AWS_SECRET_ACCESS_KEY")
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`

  const dir = await mkdtemp(join(tmpdir(), "pawwork-r2-"))
  try {
    if (!cleanupOnly) {
      const repo = process.argv[3] ?? "Astro-Han/pawwork"
      const version = tag.replace(/^v/, "")
      await mirror({ assets: releaseAssetNames(version), tag, repo, dir, bucket, endpoint, publicBase, version })
    }
    await cleanup({ dir, bucket, endpoint, publicBase }, dryRun)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function cleanup({ dir, bucket, endpoint, publicBase }: Pick<MirrorArgs, "dir" | "bucket" | "endpoint" | "publicBase">, dryRun: boolean) {
  const aws = (args: string[]) => run(["aws", "s3api", ...args, "--bucket", bucket, "--endpoint-url", endpoint, "--output", "json"])
  const inventory = async (): Promise<MirrorObject[]> => {
    const result = JSON.parse(await aws(["list-objects-v2"]))
    if (!Array.isArray(result.Contents)) throw new Error("R2 inventory is missing Contents")
    return result.Contents
  }
  const readPointers = async () => {
    const pointers: Record<string, string> = {}
    for (const name of RETENTION_POINTERS) {
      const file = join(dir, name)
      await aws(["get-object", "--key", name, file])
      pointers[name] = await readFile(file, "utf8")
    }
    return pointers
  }
  const before = await inventory()
  const pointers = await readPointers()
  const names = cleanupPlan(before, pointers, publicBase)
  const removing = new Set(names)
  const bytes = before.filter((object) => removing.has(object.Key)).reduce((sum, object) => sum + object.Size, 0)
  console.log(`Cleanup ${dryRun ? "preview" : "plan"}: ${names.length} installers, ${bytes} bytes`)
  for (const name of names) console.log(`  ${name}`)
  if (dryRun || names.length === 0) return

  const current = await readPointers()
  if (RETENTION_POINTERS.some((name) => current[name] !== pointers[name])) {
    throw new Error("Retention pointers changed; refusing cleanup")
  }
  for (let start = 0; start < names.length; start += 1000) {
    const result = JSON.parse(await aws(["delete-objects", "--delete", JSON.stringify({
      Objects: names.slice(start, start + 1000).map((Key) => ({ Key })),
      Quiet: false,
    })]))
    if (result.Errors?.length) throw new Error(`R2 deletion errors: ${JSON.stringify(result.Errors)}`)
  }
  const after = await inventory()
  const remaining = new Set(after.map((object) => object.Key))
  if (names.some((name) => remaining.has(name)) || before.some((object) => !removing.has(object.Key) && !remaining.has(object.Key))) {
    throw new Error("R2 cleanup verification failed")
  }
  console.log(`Cleanup verified: ${names.length} installers removed; ${after.length} objects retained`)
}

type MirrorArgs = {
  assets: string[]
  tag: string
  repo: string
  dir: string
  bucket: string
  endpoint: string
  publicBase: string
  version: string
}

async function mirror({ assets, tag, repo, dir, bucket, endpoint, publicBase, version }: MirrorArgs) {
  // Retrying an old tag must not roll back the live feed and then prune the
  // newer installers that clients already discovered.
  const currentFile = join(dir, "current-v2.yml")
  await run(["aws", "s3api", "get-object", "--key", releaseTarget("win", "x64").metadata, currentFile,
    "--bucket", bucket, "--endpoint-url", endpoint])
  const currentVersion = parseUpdaterVersion(await readFile(currentFile, "utf8"))
  if (!currentVersion) throw new Error("R2 v2 feed has no version; refusing to mirror")
  if (gt(currentVersion, version)) {
    throw new Error(`Refusing to replace R2 version ${currentVersion} with older version ${version}`)
  }
  console.log(`Downloading ${assets.length} assets of ${tag} from ${repo} ...`)
  for (const name of assets) {
    await run(["gh", "release", "download", tag, "--repo", repo, "--pattern", name, "--dir", dir])
  }
  const present = new Set(await readdir(dir))
  const missing = assets.filter((name) => !present.has(name))
  if (missing.length) throw new Error(`Assets missing after download: ${missing.join(", ")}`)

  // Fail before mirroring if a pointer references an asset we will not upload:
  // the generic R2 feed must be able to resolve every file the yml lists.
  const mirrored = new Set(assets)
  for (const pointer of METADATA_FILES) {
    const referenced = pointerReferencedAssets(await readFile(join(dir, pointer), "utf8"))
    const missingRefs = missingPointerReferences(referenced, mirrored)
    if (missingRefs.length) {
      throw new Error(`${pointer} references assets not mirrored to R2: ${missingRefs.join(", ")}`)
    }
  }

  const upload = async (name: string, cacheControl: string) => {
    const local = join(dir, name)
    await run([
      "aws", "s3", "cp", local, `s3://${bucket}/${name}`,
      "--endpoint-url", endpoint,
      "--content-type", contentTypeFor(name),
      "--cache-control", cacheControl,
      "--no-progress",
    ])
    const head = JSON.parse(
      await run(["aws", "s3api", "head-object", "--bucket", bucket, "--key", name, "--endpoint-url", endpoint]),
    )
    const localSize = (await stat(local)).size
    if (head.ContentLength !== localSize) {
      throw new Error(`Size mismatch for ${name}: local ${localSize} vs R2 ${head.ContentLength}`)
    }
    console.log(`  ✓ ${name} (${localSize} bytes)`)
  }

  // Upload in the load-bearing order (versioned -> updater pointers -> manifest
  // last). The manifest is generated just before its upload.
  for (const step of uploadPlan(assets)) {
    if (step.manifest) {
      await writeFile(join(dir, step.name), JSON.stringify(buildManifest(version, publicBase), null, 2))
    }
    await upload(step.name, step.cacheControl)
  }

  console.log(`Mirrored ${tag} to ${publicBase} (latest.json -> ${version}).`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
