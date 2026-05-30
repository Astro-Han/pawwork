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
import { releaseAssetNames } from "./verify-release.ts"

const MUTABLE_POINTERS = new Set(["latest.yml", "latest-mac.yml"])
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
const POINTER_CACHE = "no-cache, must-revalidate"

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
  const versioned = assets.filter((name) => !MUTABLE_POINTERS.has(name))
  const pointers = assets.filter((name) => MUTABLE_POINTERS.has(name))

  const dir = await mkdtemp(join(tmpdir(), "pawwork-r2-"))
  try {
    await mirror({ assets, versioned, pointers, tag, repo, dir, bucket, endpoint, publicBase, version })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

type MirrorArgs = {
  assets: string[]
  versioned: string[]
  pointers: string[]
  tag: string
  repo: string
  dir: string
  bucket: string
  endpoint: string
  publicBase: string
  version: string
}

async function mirror({ assets, versioned, pointers, tag, repo, dir, bucket, endpoint, publicBase, version }: MirrorArgs) {
  console.log(`Downloading ${assets.length} assets of ${tag} from ${repo} ...`)
  for (const name of assets) {
    await run(["gh", "release", "download", tag, "--repo", repo, "--pattern", name, "--dir", dir])
  }
  const present = new Set(await readdir(dir))
  const missing = assets.filter((name) => !present.has(name))
  if (missing.length) throw new Error(`Assets missing after download: ${missing.join(", ")}`)

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

  // 1. Immutable versioned artifacts first, each verified by HEAD.
  console.log("Uploading versioned artifacts ...")
  for (const name of versioned) await upload(name, IMMUTABLE_CACHE)

  // 2. electron-updater pointers (mutable, for the future #219 in-app updater).
  console.log("Uploading updater pointers ...")
  for (const name of pointers) await upload(name, POINTER_CACHE)

  // 3. Landing page pointer LAST — the single switch that makes the new
  //    release live on the site.
  const manifest = {
    version,
    macArm64: `${publicBase}/pawwork-mac-arm64-${version}.dmg`,
    macX64: `${publicBase}/pawwork-mac-x64-${version}.dmg`,
    winX64: `${publicBase}/pawwork-win-x64-${version}.exe`,
  }
  const manifestPath = join(dir, "latest.json")
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2))
  await upload("latest.json", POINTER_CACHE)

  console.log(`Mirrored ${tag} to ${publicBase} (latest.json -> ${version}).`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
