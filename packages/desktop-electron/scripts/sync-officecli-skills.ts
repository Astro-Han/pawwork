/**
 * Sync officecli SKILL.md files from upstream tag tarball into repo-root skills/.
 *
 * Maintenance script — run manually on officecli version bump, or auto-invoked
 * by .github/workflows/officecli-bump.yml. Not part of predev/prebuild/dev.
 *
 * Modes:
 *   bun sync-officecli-skills.ts                    # validate SHA, inject override, prune stale
 *   bun sync-officecli-skills.ts --compute-sha      # download tarball, compute content SHA, write to manifest, exit
 *   bun sync-officecli-skills.ts --dry-run          # do everything except writing files
 *
 * See spec: docs/superpowers/specs/2026-05-17-officecli-skill-bundle-design.md
 */
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")
const SKILLS_DIR = path.join(REPO_ROOT, "skills")
const MANIFEST_PATH = path.join(REPO_ROOT, "packages/desktop-electron/bundled-tools.json")

const OFFICECLI_BUNDLE_PREFIXES = ["officecli-", "morph-ppt"] as const

const OVERRIDE_BLOCKQUOTE = `
> **PawWork-specific note**: \`officecli\` is bundled with PawWork. Ignore the upstream install instructions in this file — do **not** run \`curl ... install.sh\` or \`irm ... install.ps1\`. If \`officecli --version\` fails inside PawWork, open **Help → Check for Updates** (PawWork ships an auto-updater) or reinstall PawWork.
`

// UTF-8 byte-order mark, written as a Unicode escape (NOT a raw BOM char in
// source). Editors / format-on-save tools strip raw zero-width BOM literals
// silently — the escape survives any text transform.
const UTF8_BOM = String.fromCharCode(0xfeff)

// Names matching the officecli skill bundle. Used in BOTH extractTarball (hard-fail
// guard when a bundle dir lacks SKILL.md) AND pruneSkillsDir (delete-vs-warn rule).
// Defined here so Task 4's typecheck checkpoint sees a resolved symbol before Task 5 lands.
export function matchesBundlePrefix(name: string): boolean {
  if (name.startsWith("officecli-")) return true
  if (name === "morph-ppt") return true
  if (name.startsWith("morph-ppt-")) return true
  return false
}

export function injectOverride(content: string): string {
  // Skip optional UTF-8 BOM (UTF8_BOM is String.fromCharCode(0xfeff); avoid raw BOM in source)
  let body = content
  let bomPrefix = ""
  if (body.startsWith(UTF8_BOM)) {
    bomPrefix = UTF8_BOM
    body = body.slice(1)
  }

  // Detect line ending and split. Bun/Node split on /\r\n|\n/ strips both styles uniformly.
  const lines = body.split(/\r\n|\n/)
  const lineEnding = body.includes("\r\n") ? "\r\n" : "\n"

  // Line 1 must be the opening --- (tolerating trailing whitespace)
  if (!/^---\s*$/.test(lines[0] ?? "")) {
    throw new Error("SKILL.md is missing frontmatter (expected line 1 to be '---')")
  }

  // Scan from line 2 onward for the closing ---
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    throw new Error("SKILL.md has unclosed frontmatter (no second '---' line found)")
  }

  const before = lines.slice(0, closeIdx + 1)  // [..., "---"]
  let after = lines.slice(closeIdx + 1)        // body lines after frontmatter close

  // Skip any leading blank lines in `after` so we don't double-blank when our
  // override block has its own leading blank. Upstream SKILL.md typically has
  // one blank line right after frontmatter close — without this trim we'd end
  // up with two consecutive blanks between frontmatter and override.
  while (after.length > 0 && after[0] === "") {
    after = after.slice(1)
  }

  // Build the override section explicitly: one blank, the blockquote line, one blank.
  // OVERRIDE_BLOCKQUOTE is "\n> **PawWork-specific note**...\n"; trim to bare text then re-wrap
  // so blank-line discipline is locally controlled, not template-string-dependent.
  const overrideText = OVERRIDE_BLOCKQUOTE.trim()  // "> **PawWork-specific note**: ..."
  const overrideSection = ["", overrideText, ""]

  const result = [...before, ...overrideSection, ...after].join(lineEnding)
  return bomPrefix + result
}

export function computeContentSha(files: Map<string, Buffer>): string {
  const sortedPaths = [...files.keys()].sort()
  const outer = createHash("sha256")
  for (const p of sortedPaths) {
    const content = files.get(p)!
    const inner = createHash("sha256").update(content).digest("hex")
    // Canonical line: "<sha256-of-content>  <path>\n"
    outer.update(`${inner}  ${p}\n`)
  }
  return outer.digest("hex")
}

export function localTarArchive(
  tarballPath: string,
  platform: NodeJS.Platform = process.platform,
): { cwd: string; archiveArg: string } {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const archiveName = pathApi.basename(tarballPath)
  return {
    cwd: pathApi.dirname(tarballPath),
    archiveArg: `./${archiveName}`,
  }
}

export type ExtractedFiles = Map<string, Buffer>

async function walkFiles(rootDir: string, relPrefix: string, out: Map<string, Buffer>) {
  const entries = await readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    const abs = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(abs, rel, out)
    } else if (entry.isFile()) {
      out.set(rel, await readFile(abs))
    }
    // Symlinks and other entry types are intentionally skipped — upstream officecli
    // does not ship them, and pulling them in would expand the trust surface.
  }
}

/**
 * Extract a local tarball at `tarballPath`. Returns a map of "<skill-name>/<rel-path>" → file contents
 * (paths relative to skills/ inside the tarball). Includes SKILL.md plus every companion file
 * (editing.md, creating.md, reference/*, etc.) so packaged bundles can resolve the cross-doc
 * links that upstream SKILL.md uses for progressive disclosure.
 */
export async function extractTarball(tarballPath: string): Promise<ExtractedFiles> {
  const extractDir = await mkdtemp(path.join(tmpdir(), "officecli-skills-"))
  try {
    const archive = localTarArchive(tarballPath)
    await execFileAsync("tar", ["-xzf", archive.archiveArg, "-C", extractDir], { cwd: archive.cwd })
    // The tarball root is `<repo-name>-<sha>` (GitHub convention). Find the single top-level dir.
    const topEntries = await readdir(extractDir, { withFileTypes: true })
    const topDirs = topEntries.filter((e) => e.isDirectory())
    if (topDirs.length !== 1) {
      throw new Error(`Expected single top-level dir in tarball, got ${topDirs.length}`)
    }
    const skillsRoot = path.join(extractDir, topDirs[0].name, "skills")
    if (!(await stat(skillsRoot).catch(() => null))?.isDirectory()) {
      throw new Error(`Tarball does not contain a skills/ directory at ${topDirs[0].name}/skills`)
    }
    const skillDirs = await readdir(skillsRoot, { withFileTypes: true })
    const result: ExtractedFiles = new Map()
    for (const entry of skillDirs) {
      if (!entry.isDirectory()) continue
      const skillDir = path.join(skillsRoot, entry.name)
      const skillFile = path.join(skillDir, "SKILL.md")
      const skillStat = await stat(skillFile).catch(() => null)
      if (!skillStat?.isFile()) {
        // Bundle-prefixed dir without SKILL.md = upstream layout drift inside the bundle we
        // care about → hard-fail so the diff gets human review.
        // Non-prefix dir without SKILL.md = upstream organizational subdir (README/, assets/,
        // __tests__/, etc.) → silent skip so future upstream housekeeping doesn't break sync.
        if (matchesBundlePrefix(entry.name)) {
          throw new Error(
            `Tarball entry skills/${entry.name}/ matches bundle prefix but has no SKILL.md. ` +
              `Upstream layout may have changed — please review before re-running sync.`,
          )
        }
        continue
      }
      await walkFiles(skillDir, entry.name, result)
    }
    return result
  } finally {
    await rm(extractDir, { recursive: true, force: true })
  }
}

export async function pruneSkillsDir(
  dir: string,
  upstreamNames: string[],
  logger: { warn(msg: string): void } = console,
): Promise<{ deleted: string[]; kept: string[]; warned: string[] }> {
  const upstreamSet = new Set(upstreamNames)
  const entries = await readdir(dir, { withFileTypes: true })
  const deleted: string[] = []
  const kept: string[] = []
  const warned: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (upstreamSet.has(name)) {
      kept.push(name)
      continue
    }
    if (matchesBundlePrefix(name)) {
      await rm(path.join(dir, name), { recursive: true, force: true })
      deleted.push(name)
      continue
    }
    // Unrecognized — keep and warn
    kept.push(name)
    warned.push(name)
    logger.warn(
      `[sync-skills] unrecognized dir skills/${name}/ — if upstream introduced a new naming convention, update matchesBundlePrefix in sync-officecli-skills.ts; otherwise ignore (user-custom)`,
    )
  }

  return { deleted, kept, warned }
}

export interface SyncOptions {
  computeSha?: boolean
  dryRun?: boolean
  /** Override for testing: skip network and return the fixture tarball as a local path */
  tarballPathOverride?: string
  /** Override for testing: read/write the manifest at this path instead of the repo manifest */
  manifestPathOverride?: string
  /** Override for testing: write skills into this directory instead of the repo `skills/` */
  skillsDirOverride?: string
}

export async function syncSkills(opts: SyncOptions): Promise<void> {
  // Read the manifest fresh from disk so tests can route this through manifestPathOverride.
  // The top-level `manifest` constant (loaded at module-import time) would only see the
  // real repo manifest, defeating the override.
  const manifestPath = opts.manifestPathOverride ?? MANIFEST_PATH
  const manifestRaw = await readFile(manifestPath, "utf8")
  const manifestParsed = JSON.parse(manifestRaw) as { officecli: { repo: string; version: string; skillsTarballSha256?: string } }
  const officecli = manifestParsed.officecli
  const { repo, version } = officecli
  const dryRun = opts.dryRun ?? false
  const computeSha = opts.computeSha ?? false
  const skillsDir = opts.skillsDirOverride ?? SKILLS_DIR

  // 1. Obtain tarball: either via override (tests) or real download
  let tarballPath: string
  let tarballCacheDir: string | null = null
  if (opts.tarballPathOverride) {
    tarballPath = opts.tarballPathOverride
  } else {
    const url = `https://github.com/${repo}/archive/refs/tags/${version}.tar.gz`
    console.log(`[sync-skills] downloading ${url}`)
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) })
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
    }
    const buf = Buffer.from(await response.arrayBuffer())
    tarballCacheDir = await mkdtemp(path.join(tmpdir(), "officecli-tarball-"))
    tarballPath = path.join(tarballCacheDir, `${version}.tar.gz`)
    await writeFile(tarballPath, buf)
  }

  try {
    // 2. Extract
    const files = await extractTarball(tarballPath)
    // Each map key is "<skill-name>/<rel-path>"; collapse to the set of skill names.
    const upstreamNames = [...new Set([...files.keys()].map((k) => k.split("/")[0]))].sort()
    console.log(
      `[sync-skills] extracted ${upstreamNames.length} skills (${files.size} files): ${upstreamNames.join(", ")}`,
    )

    // Safety guard: pruneSkillsDir will delete every officecli-*/morph-ppt* dir that is NOT
    // in upstreamNames. If the extracted tarball contains zero bundle-prefix skills (either
    // upstream layout drift, a fetch error, a corrupted archive, OR a future upstream that
    // ships only non-bundle sub-folders like `skills/templates/`), proceeding would wipe
    // every existing bundle dir without replacement. Filter by bundle prefix so a non-empty
    // but bundle-empty extraction also fails closed.
    const upstreamBundleNames = upstreamNames.filter(matchesBundlePrefix)
    if (upstreamBundleNames.length === 0) {
      throw new Error(
        `extractTarball returned 0 bundle-prefix skills for ${repo}@${version} ` +
          `(extracted: ${upstreamNames.join(", ") || "<none>"}). ` +
          `Refusing to proceed — upstream layout may have changed or the tarball is corrupt.`,
      )
    }

    // 3. Compute content SHA
    const contentSha = computeContentSha(files)
    console.log(`[sync-skills] content SHA256: ${contentSha}`)

    // 4. Mode: --compute-sha → write SHA to manifest and exit
    if (computeSha) {
      if (dryRun) {
        console.log(`[sync-skills] (dry-run) would write skillsTarballSha256=${contentSha} to manifest`)
        return
      }
      manifestParsed.officecli.skillsTarballSha256 = contentSha
      await writeFile(manifestPath, JSON.stringify(manifestParsed, null, 2) + "\n")
      console.log(`[sync-skills] wrote skillsTarballSha256 to ${manifestPath}`)
      return
    }

    // 5. Default mode: validate SHA against manifest
    const expected = officecli.skillsTarballSha256
    if (!expected) {
      throw new Error(
        `skillsTarballSha256 is missing from bundled-tools.json. Run with --compute-sha first to bootstrap.`,
      )
    }
    if (expected !== contentSha) {
      throw new Error(
        `SHA256 mismatch: manifest=${expected}, computed=${contentSha}. ` +
          `If upstream tag was retargeted, review the diff and re-run --compute-sha.`,
      )
    }

    // 6. Inject override into each SKILL.md + write every file (companion docs included).
    //    Non-SKILL.md files (editing.md, creating.md, reference/*, etc.) are written byte-for-byte
    //    so the skill tool's <skill_files> sampling can surface them to the model.
    if (dryRun) {
      console.log(`[sync-skills] (dry-run) would write ${files.size} files under ${skillsDir}`)
    } else {
      // Wipe each upstream skill dir first so stale companion files (e.g. an upstream rename
      // from editing.md → edit.md) do not linger alongside the freshly written ones.
      for (const name of upstreamNames) {
        await rm(path.join(skillsDir, name), { recursive: true, force: true })
      }
      let skillMdCount = 0
      for (const [relPath, content] of files) {
        const destPath = path.join(skillsDir, relPath)
        await mkdir(path.dirname(destPath), { recursive: true })
        if (relPath.endsWith("/SKILL.md")) {
          const transformed = injectOverride(content.toString("utf8"))
          await writeFile(destPath, transformed, "utf8")
          skillMdCount += 1
        } else {
          await writeFile(destPath, content)
        }
      }
      console.log(
        `[sync-skills] wrote ${files.size} files across ${upstreamNames.length} skills ` +
          `(${skillMdCount} SKILL.md with override + ${files.size - skillMdCount} companion files)`,
      )
    }

    // 7. Prune stale directories
    const skillsDirExists = await stat(skillsDir).then((s) => s.isDirectory()).catch(() => false)
    if (skillsDirExists) {
      if (dryRun) {
        console.log(`[sync-skills] (dry-run) skipping prune`)
      } else {
        const result = await pruneSkillsDir(skillsDir, upstreamNames)
        console.log(`[sync-skills] pruned ${result.deleted.length} stale dirs; kept ${result.kept.length}; warned ${result.warned.length}`)
      }
    }

    // 8. Print summary
    console.log(`[sync-skills] done. Review with: git diff skills/`)
  } finally {
    if (tarballCacheDir) {
      await rm(tarballCacheDir, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  const computeSha = process.argv.includes("--compute-sha")
  const dryRun = process.argv.includes("--dry-run")
  try {
    await syncSkills({ computeSha, dryRun })
    process.exit(0)
  } catch (err) {
    console.error(`[sync-skills] failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
