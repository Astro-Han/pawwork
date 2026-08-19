import { execFile } from "node:child_process"
import { access, mkdtemp, readFile as readTextFile, writeFile } from "node:fs/promises"
import path from "path"
import { promisify } from "node:util"
import { parseUpdaterMetadata } from "./updater-metadata"

const execFileAsync = promisify(execFile)

const dir = process.env.LATEST_YML_DIR!
if (!dir) throw new Error("LATEST_YML_DIR is required")

const repo = process.env.GH_REPO
if (!repo) throw new Error("GH_REPO is required")

const version = process.env.OPENCODE_VERSION
if (!version) throw new Error("OPENCODE_VERSION is required")

type FileEntry = {
  url: string
  sha512: string
  size: number
  blockMapSize?: number
}

type LatestYml = {
  version: string
  files: FileEntry[]
  releaseDate: string
}

function parse(content: string): LatestYml {
  const metadata = parseUpdaterMetadata(content)
  const files = metadata.files.flatMap((file) =>
    file.sha512 !== undefined && file.size !== undefined
      ? [{ url: file.url, sha512: file.sha512, size: file.size, ...(file.blockMapSize === undefined ? {} : { blockMapSize: file.blockMapSize }) }]
      : [],
  )
  return { version: metadata.version ?? "", files, releaseDate: metadata.releaseDate ?? "" }
}

function serialize(data: LatestYml) {
  const lines = [`version: ${data.version}`, "files:"]
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`)
    lines.push(`    sha512: ${file.sha512}`)
    lines.push(`    size: ${file.size}`)
    if (file.blockMapSize) lines.push(`    blockMapSize: ${file.blockMapSize}`)
  }
  lines.push(`releaseDate: '${data.releaseDate}'`)
  return lines.join("\n") + "\n"
}

async function read(subdir: string, filename: string): Promise<LatestYml | undefined> {
  return await readFile(path.join(dir, subdir, filename))
}

async function readFile(filepath: string): Promise<LatestYml | undefined> {
  try {
    await access(filepath)
  } catch {
    return undefined
  }
  return parse(await readTextFile(filepath, "utf8"))
}

async function gh(args: string[]) {
  return await execFileAsync("gh", args)
}

function mergeLatest(...items: Array<LatestYml | undefined>): LatestYml | undefined {
  const present = items.filter((item): item is LatestYml => Boolean(item))
  if (present.length === 0) return undefined

  const files = new Map<string, FileEntry>()
  // On URL collision, later items overwrite earlier entries so live/current data wins.
  for (const item of present) {
    for (const file of item.files) files.set(file.url, file)
  }

  // Use the last item as the metadata base so fresh live releaseDate and version fields win over cached snapshots.
  const base = present.at(-1)!
  return {
    version: base.version,
    files: [...files.values()],
    releaseDate: base.releaseDate,
  }
}

function shellErrorText(error: unknown) {
  const parts: string[] = []
  if (error instanceof Error) parts.push(error.message)
  else parts.push(String(error))
  const maybe = error as { stdout?: unknown; stderr?: unknown }
  if (maybe.stderr) parts.push(String(maybe.stderr))
  if (maybe.stdout) parts.push(String(maybe.stdout))
  return parts.join("\n")
}

function isMissingAssetError(message: string) {
  // `gh release download` does not expose an asset-missing exit code, so keep this
  // narrow and let generic 404/release/repo/auth failures propagate.
  return /no assets to download|no matches found|no assets match|could not find any assets|release not found/i.test(
    message,
  )
}

function assertSameVersion(source: string, filename: string, data: LatestYml | undefined) {
  if (data && data.version !== version) {
    throw new Error(`Existing ${filename} from ${source} has version ${data.version}, expected ${version}`)
  }
  return data
}

async function downloadExisting(tag: string, filename: string) {
  const configured = process.env.EXISTING_LATEST_YML_DIR
  const cached = assertSameVersion(
    "EXISTING_LATEST_YML_DIR",
    filename,
    configured ? await readFile(path.join(configured, filename)) : undefined,
  )

  const liveDir = await mkdtemp(path.join(tmp, "live-latest-yml-"))
  try {
    await gh(["release", "download", tag, "--pattern", filename, "--dir", liveDir, "--repo", repo, "--clobber"])
  } catch (error) {
    const message = shellErrorText(error)
    if (isMissingAssetError(message)) return cached
    throw new Error(`Failed to download existing ${filename}: ${message}`)
  }
  const live = assertSameVersion("GitHub release", filename, await readFile(path.join(liveDir, filename)))
  return mergeLatest(cached, live)
}

// Refuse to rewrite a release that is already published. In the normal flow the
// release stays a draft until the auto-publisher flips it at the very end, after
// every target's finalize has run; a published release here therefore means a
// later same-version build (from a different commit) — clobbering its latest*.yml
// would point the published metadata at hashes that no longer match the published
// installers, breaking auto-update. Fail loudly instead (re-release with a bumped
// version). A missing release is fine: nothing to clobber yet.
async function assertReleaseIsDraft(releaseTag: string) {
  let isDraft: boolean
  try {
    const { stdout } = await gh(["release", "view", releaseTag, "--json", "isDraft", "--jq", ".isDraft", "--repo", repo])
    isDraft = stdout.trim() === "true"
  } catch (error) {
    const message = shellErrorText(error)
    if (/release not found|not found/i.test(message)) return
    throw new Error(`Failed to read release state for ${releaseTag}: ${message}`)
  }
  if (!isDraft) {
    throw new Error(
      `Release ${releaseTag} is already published; refusing to overwrite its updater metadata from a later build`,
    )
  }
}

const output: Record<string, string> = {}
const tag = `v${version}`
const tmp = process.env.RUNNER_TEMP ?? "/tmp"

// Windows x64
const winX64 = await read("latest-yml-x86_64-pc-windows-msvc", "latest.yml")
if (winX64) {
  output["latest.yml"] = serialize(
    mergeLatest(await downloadExisting(tag, "latest.yml"), {
      version: winX64.version,
      files: winX64.files,
      releaseDate: winX64.releaseDate,
    })!,
  )
}

// macOS: merge arm64 + x64 into single file
const macX64 = await read("latest-yml-x86_64-apple-darwin", "latest-mac.yml")
const macArm64 = await read("latest-yml-aarch64-apple-darwin", "latest-mac.yml")
if (macX64 || macArm64) {
  const base = macArm64 ?? macX64!
  output["latest-mac.yml"] = serialize(
    mergeLatest(await downloadExisting(tag, "latest-mac.yml"), {
      version: base.version,
      files: [...(macArm64?.files ?? []), ...(macX64?.files ?? [])],
      releaseDate: base.releaseDate,
    })!,
  )
}

// Upload to release. Re-checked right before the writes to shrink the window
// between observing a draft and clobbering it.
await assertReleaseIsDraft(tag)
for (const [filename, content] of Object.entries(output)) {
  const filepath = path.join(tmp, filename)
  await writeFile(filepath, content)
  await gh(["release", "upload", tag, filepath, "--clobber", "--repo", repo])
  console.log(`uploaded ${filename}`)
}

console.log("finalized latest yml files")
