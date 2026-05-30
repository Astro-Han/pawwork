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
// Usage: bun packages/desktop-electron/scripts/mirror-release-to-r2.ts <tag> [owner/repo]
// Env:
//   R2_ACCOUNT_ID            Cloudflare account id (S3 endpoint host)
//   R2_BUCKET                target bucket, e.g. pawwork-downloads
//   DOWNLOAD_PUBLIC_BASE     public base URL, e.g. https://dl.pawwork.ai
//   AWS_ACCESS_KEY_ID        R2 token access key (S3-compatible)
//   AWS_SECRET_ACCESS_KEY    R2 token secret
//   GH_TOKEN                 GitHub token for `gh release download`

import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseUpdaterFileUrls, releaseAssetNames } from "./verify-release.ts"

const POINTER_YMLS = ["latest.yml", "latest-mac.yml"] as const

const MUTABLE_POINTERS = new Set(["latest.yml", "latest-mac.yml"])
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
const POINTER_CACHE = "no-cache, must-revalidate"
const MANIFEST_NAME = "latest.json"

export type UploadStep = { name: string; cacheControl: string; manifest?: boolean }

// Pointer object the landing page reads to swap download buttons to R2 links.
// Keys match the data-dl attributes on the buttons in site/src/pages/index.astro.
export function buildManifest(version: string, publicBase: string) {
  const base = publicBase.replace(/\/$/, "")
  return {
    version,
    macArm64: `${base}/pawwork-mac-arm64-${version}.dmg`,
    macX64: `${base}/pawwork-mac-x64-${version}.dmg`,
    winX64: `${base}/pawwork-win-x64-${version}.exe`,
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
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`Command failed (${code}): ${cmd.join(" ")}\n${stderr}`)
  return stdout
}

async function main() {
  const tag = process.argv[2]
  if (!tag) {
    console.error("Usage: bun packages/desktop-electron/scripts/mirror-release-to-r2.ts <tag> [owner/repo]")
    process.exit(1)
  }
  const repo = process.argv[3] ?? "Astro-Han/pawwork"
  const version = tag.replace(/^v/, "")

  const accountId = requireEnv("R2_ACCOUNT_ID")
  const bucket = requireEnv("R2_BUCKET")
  const publicBase = requireEnv("DOWNLOAD_PUBLIC_BASE").replace(/\/$/, "")
  requireEnv("AWS_ACCESS_KEY_ID")
  requireEnv("AWS_SECRET_ACCESS_KEY")
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`

  const assets = releaseAssetNames(version)

  const dir = await mkdtemp(join(tmpdir(), "pawwork-r2-"))
  try {
    await mirror({ assets, tag, repo, dir, bucket, endpoint, publicBase, version })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
  for (const pointer of POINTER_YMLS) {
    const referenced = pointerReferencedAssets(await Bun.file(join(dir, pointer)).text())
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
      await Bun.write(join(dir, step.name), JSON.stringify(buildManifest(version, publicBase), null, 2))
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
