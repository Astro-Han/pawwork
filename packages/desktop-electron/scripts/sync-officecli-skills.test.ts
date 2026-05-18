import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  computeContentSha,
  extractTarball,
  injectOverride,
  localTarArchive,
  pruneSkillsDir,
  syncSkills,
} from "./sync-officecli-skills"

const execFileAsync = promisify(execFile)

describe("injectOverride", () => {
  const LF_FIXTURE = `---
name: officecli-xlsx
description: test
---

# OfficeCLI XLSX Skill

## Setup

curl install.sh

## Help-First Rule
`

  test("inserts blockquote after LF frontmatter", () => {
    const result = injectOverride(LF_FIXTURE)
    // override appears after the closing --- line and before the first body line
    expect(result).toContain("---\nname: officecli-xlsx")
    const lines = result.split("\n")
    const closeIdx = lines.indexOf("---", 1)
    expect(lines[closeIdx + 1]).toBe("")
    expect(lines[closeIdx + 2]).toContain("PawWork-specific note")
    expect(result).toContain("Ignore the upstream install instructions")
  })

  test("inserts blockquote after CRLF frontmatter and preserves CRLF in body", () => {
    const crlf = LF_FIXTURE.replace(/\n/g, "\r\n")
    const result = injectOverride(crlf)
    expect(result).toContain("PawWork-specific note")
    // body content after override still uses CRLF
    expect(result).toContain("# OfficeCLI XLSX Skill\r\n")
  })

  test("inserts blockquote after frontmatter preceded by UTF-8 BOM", () => {
    // Use String.fromCharCode to avoid raw BOM in test source (would be stripped by editors).
    const BOM = String.fromCharCode(0xfeff)
    const bom = BOM + LF_FIXTURE
    const result = injectOverride(bom)
    expect(result.startsWith(BOM + "---")).toBe(true)
    expect(result).toContain("PawWork-specific note")
  })

  test("does not mistake body horizontal rule for frontmatter close", () => {
    const withHr = `---
name: x
description: y
---

# Title

Body paragraph.

---

Another section after horizontal rule.
`
    const result = injectOverride(withHr)
    // override should be injected after the first --- close (line 4), not after the body HR
    const lines = result.split("\n")
    // find the override line
    const overrideIdx = lines.findIndex((l) => l.includes("PawWork-specific note"))
    expect(overrideIdx).toBeGreaterThan(0)
    // it must come BEFORE the body "# Title"
    const titleIdx = lines.findIndex((l) => l === "# Title")
    expect(overrideIdx).toBeLessThan(titleIdx)
  })

  test("hard fails when file has no frontmatter", () => {
    const noFm = `# Title\n\nBody.\n`
    expect(() => injectOverride(noFm)).toThrow(/frontmatter/i)
  })

  test("hard fails when frontmatter is unclosed", () => {
    const unclosed = `---\nname: x\ndescription: y\n\n# Title\n`
    expect(() => injectOverride(unclosed)).toThrow(/frontmatter/i)
  })
})

describe("computeContentSha", () => {
  test("returns same hash regardless of map insertion order", () => {
    const a = new Map<string, Buffer>([
      ["skills/xlsx/SKILL.md", Buffer.from("xlsx content")],
      ["skills/docx/SKILL.md", Buffer.from("docx content")],
    ])
    const b = new Map<string, Buffer>([
      ["skills/docx/SKILL.md", Buffer.from("docx content")],
      ["skills/xlsx/SKILL.md", Buffer.from("xlsx content")],
    ])
    expect(computeContentSha(a)).toBe(computeContentSha(b))
  })

  test("returns different hash when a file content changes", () => {
    const a = new Map<string, Buffer>([["skills/x/SKILL.md", Buffer.from("v1")]])
    const b = new Map<string, Buffer>([["skills/x/SKILL.md", Buffer.from("v2")]])
    expect(computeContentSha(a)).not.toBe(computeContentSha(b))
  })

  test("returns 64-char lowercase hex", () => {
    const m = new Map<string, Buffer>([["skills/x/SKILL.md", Buffer.from("hello")]])
    const hash = computeContentSha(m)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("localTarArchive", () => {
  test("keeps Windows drive letters out of tar archive arguments", () => {
    const archive = localTarArchive("D:\\a\\pawwork\\bundle.tar.gz", "win32")
    expect(archive.cwd).toBe("D:\\a\\pawwork")
    expect(archive.archiveArg).toBe("./bundle.tar.gz")
    expect(archive.archiveArg).not.toContain(":")
  })
})

async function setupSkillsFixture(names: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "prune-test-"))
  for (const n of names) {
    await mkdir(path.join(dir, n), { recursive: true })
    await writeFile(path.join(dir, n, "SKILL.md"), `---\nname: ${n}\ndescription: t\n---\n`)
  }
  return dir
}

describe("pruneSkillsDir", () => {
  test("keeps directories present in upstream list", async () => {
    const dir = await setupSkillsFixture(["officecli-xlsx", "officecli-docx"])
    try {
      const result = await pruneSkillsDir(dir, ["officecli-xlsx", "officecli-docx"])
      expect(result.deleted).toEqual([])
      expect(result.kept.sort()).toEqual(["officecli-docx", "officecli-xlsx"])
      expect(result.warned).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("deletes directories matching officecli- prefix but absent from upstream", async () => {
    const dir = await setupSkillsFixture(["officecli-xlsx", "officecli-defunct"])
    try {
      const result = await pruneSkillsDir(dir, ["officecli-xlsx"])
      expect(result.deleted).toEqual(["officecli-defunct"])
      expect(result.kept).toEqual(["officecli-xlsx"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("deletes directories matching morph-ppt prefix but absent from upstream", async () => {
    const dir = await setupSkillsFixture(["morph-ppt", "morph-ppt-3d", "morph-ppt-defunct"])
    try {
      const result = await pruneSkillsDir(dir, ["morph-ppt", "morph-ppt-3d"])
      expect(result.deleted).toEqual(["morph-ppt-defunct"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps and warns directories not matching any bundle prefix", async () => {
    const dir = await setupSkillsFixture(["officecli-xlsx", "custom-thing", "data-analysis"])
    const warnings: string[] = []
    try {
      const result = await pruneSkillsDir(
        dir,
        ["officecli-xlsx"],
        { warn: (msg) => warnings.push(msg) },
      )
      expect(result.deleted).toEqual([])
      expect(result.kept.sort()).toEqual(["custom-thing", "data-analysis", "officecli-xlsx"])
      expect(result.warned.sort()).toEqual(["custom-thing", "data-analysis"])
      expect(warnings.length).toBe(2)
      expect(warnings.join("\n")).toContain("unrecognized")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Build a tarball at test time from a structured layout. `layout` is a map of
// `relPath` → `contents | null`; `null` means "create this directory but no file".
// Root dir name is `<rootName>` to mimic GitHub's `<repo>-<sha>/` top-level dir.
async function buildFixtureTarball(rootName: string, layout: Record<string, string | null>): Promise<string> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "extract-tarball-test-"))
  const rootDir = path.join(stagingDir, rootName)
  await mkdir(rootDir, { recursive: true })
  for (const [relPath, contents] of Object.entries(layout)) {
    const absPath = path.join(rootDir, relPath)
    if (contents === null) {
      await mkdir(absPath, { recursive: true })
    } else {
      await mkdir(path.dirname(absPath), { recursive: true })
      await writeFile(absPath, contents, "utf8")
    }
  }
  const tarballPath = path.join(stagingDir, `${rootName}.tar.gz`)
  const archive = localTarArchive(tarballPath)
  await execFileAsync("tar", ["-czf", archive.archiveArg, "-C", stagingDir, rootName], { cwd: archive.cwd })
  return tarballPath
}

describe("extractTarball", () => {
  test("extracts skills/ subdirectory files from fixture tarball", async () => {
    const fixturePath = path.join(import.meta.dirname, "__fixtures__/sync-skills/mini-skills.tar.gz")
    const files = await extractTarball(fixturePath)
    const keys = [...files.keys()].sort()
    expect(keys).toEqual(["officecli-bar/SKILL.md", "officecli-foo/SKILL.md"])
    expect(files.get("officecli-foo/SKILL.md")!.toString("utf8")).toContain("name: officecli-foo")
  })

  test("hard-fails when a bundle-prefix dir lacks SKILL.md", async () => {
    // upstream layout drift inside our bundle → must NOT silently skip
    const tarball = await buildFixtureTarball("repo-sha", {
      "skills/officecli-good/SKILL.md": "---\nname: good\n---\n",
      "skills/officecli-broken": null, // bundle-prefix dir, no SKILL.md inside
    })
    await expect(extractTarball(tarball)).rejects.toThrow(/officecli-broken.*matches bundle prefix but has no SKILL.md/)
    await rm(path.dirname(tarball), { recursive: true, force: true })
  })

  test("silently skips non-bundle dirs without SKILL.md", async () => {
    // upstream housekeeping subdir (e.g. templates/, README/) → must NOT break sync
    const tarball = await buildFixtureTarball("repo-sha", {
      "skills/officecli-good/SKILL.md": "---\nname: good\n---\n",
      "skills/templates": null, // not a bundle prefix, no SKILL.md
      "skills/morph-ppt/SKILL.md": "---\nname: morph\n---\n",
    })
    const files = await extractTarball(tarball)
    const keys = [...files.keys()].sort()
    expect(keys).toEqual(["morph-ppt/SKILL.md", "officecli-good/SKILL.md"])
    await rm(path.dirname(tarball), { recursive: true, force: true })
  })

  test("includes companion docs and nested reference assets alongside SKILL.md", async () => {
    // upstream skills/<name>/ ships SKILL.md + sibling editing.md/creating.md and a
    // reference/ subtree — the packaged bundle must surface them so the model can
    // follow the cross-doc links in SKILL.md.
    const tarball = await buildFixtureTarball("repo-sha", {
      "skills/officecli-docx/SKILL.md": "---\nname: docx\n---\n",
      "skills/officecli-docx/editing.md": "edit guide",
      "skills/officecli-docx/creating.md": "create guide",
      "skills/morph-ppt/SKILL.md": "---\nname: morph\n---\n",
      "skills/morph-ppt/reference/decision-rules.md": "rules",
      "skills/morph-ppt/reference/styles/INDEX.md": "styles",
    })
    const files = await extractTarball(tarball)
    const keys = [...files.keys()].sort()
    expect(keys).toEqual([
      "morph-ppt/SKILL.md",
      "morph-ppt/reference/decision-rules.md",
      "morph-ppt/reference/styles/INDEX.md",
      "officecli-docx/SKILL.md",
      "officecli-docx/creating.md",
      "officecli-docx/editing.md",
    ])
    expect(files.get("officecli-docx/editing.md")!.toString("utf8")).toBe("edit guide")
    expect(files.get("morph-ppt/reference/styles/INDEX.md")!.toString("utf8")).toBe("styles")
    await rm(path.dirname(tarball), { recursive: true, force: true })
  })
})

describe("syncSkills (integration, fixture-driven)", () => {
  // Build a tempdir manifest mirror so tests can exercise the real write path without
  // touching the repo's bundled-tools.json. The fields mirror what syncSkills reads.
  async function makeTempManifest(seed: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "sync-manifest-"))
    const manifestPath = path.join(dir, "bundled-tools.json")
    await writeFile(manifestPath, JSON.stringify({ officecli: seed }, null, 2) + "\n", "utf8")
    return manifestPath
  }

  test("--compute-sha (non-dry) writes content SHA into the manifest", async () => {
    const fixturePath = path.join(import.meta.dirname, "__fixtures__/sync-skills/mini-skills.tar.gz")
    const manifestPath = await makeTempManifest({
      repo: "iOfficeAI/OfficeCLI",
      version: "v0.0.0-fixture",
      // intentionally omit skillsTarballSha256 — this is the bootstrap scenario
    })
    await syncSkills({ computeSha: true, tarballPathOverride: fixturePath, manifestPathOverride: manifestPath })
    const raw = await readFile(manifestPath, "utf8")
    const parsed = JSON.parse(raw) as { officecli: { skillsTarballSha256?: string } }
    expect(parsed.officecli.skillsTarballSha256).toMatch(/^[0-9a-f]{64}$/)
    await rm(path.dirname(manifestPath), { recursive: true, force: true })
  })

  test("--compute-sha + --dry-run does NOT mutate manifest", async () => {
    const fixturePath = path.join(import.meta.dirname, "__fixtures__/sync-skills/mini-skills.tar.gz")
    const manifestPath = await makeTempManifest({
      repo: "iOfficeAI/OfficeCLI",
      version: "v0.0.0-fixture",
    })
    const before = await readFile(manifestPath, "utf8")
    await syncSkills({ computeSha: true, dryRun: true, tarballPathOverride: fixturePath, manifestPathOverride: manifestPath })
    const after = await readFile(manifestPath, "utf8")
    expect(after).toBe(before)
    await rm(path.dirname(manifestPath), { recursive: true, force: true })
  })

  test("default mode rejects when manifest SHA is missing", async () => {
    const fixturePath = path.join(import.meta.dirname, "__fixtures__/sync-skills/mini-skills.tar.gz")
    const manifestPath = await makeTempManifest({
      repo: "iOfficeAI/OfficeCLI",
      version: "v0.0.0-fixture",
      // no skillsTarballSha256 → must error
    })
    await expect(
      syncSkills({ dryRun: true, tarballPathOverride: fixturePath, manifestPathOverride: manifestPath }),
    ).rejects.toThrow(/missing/i)
    await rm(path.dirname(manifestPath), { recursive: true, force: true })
  })

  test("default mode rejects when manifest SHA does not match fixture", async () => {
    const fixturePath = path.join(import.meta.dirname, "__fixtures__/sync-skills/mini-skills.tar.gz")
    const manifestPath = await makeTempManifest({
      repo: "iOfficeAI/OfficeCLI",
      version: "v0.0.0-fixture",
      skillsTarballSha256: "0".repeat(64), // intentionally wrong
    })
    await expect(
      syncSkills({ dryRun: true, tarballPathOverride: fixturePath, manifestPathOverride: manifestPath }),
    ).rejects.toThrow(/sha256 mismatch/i)
    await rm(path.dirname(manifestPath), { recursive: true, force: true })
  })

  test("default mode writes companion docs byte-identical and injects override only into SKILL.md", async () => {
    // Build a fixture with one bundle-prefix skill that has companion docs + a reference subtree.
    const tarball = await buildFixtureTarball("repo-sha", {
      "skills/officecli-foo/SKILL.md": "---\nname: officecli-foo\ndescription: t\n---\n\n# Body\n",
      "skills/officecli-foo/editing.md": "edit guide body",
      "skills/officecli-foo/reference/styles/INDEX.md": "styles index",
    })
    const manifestPath = await makeTempManifest({
      repo: "iOfficeAI/OfficeCLI",
      version: "v0.0.0-fixture",
    })
    const skillsDir = await mkdtemp(path.join(tmpdir(), "sync-dest-"))

    try {
      // Bootstrap the SHA first.
      await syncSkills({
        computeSha: true,
        tarballPathOverride: tarball,
        manifestPathOverride: manifestPath,
        skillsDirOverride: skillsDir,
      })

      // Default mode writes files. SKILL.md gets the override blockquote; companion files are
      // written byte-for-byte from the tarball.
      await syncSkills({
        tarballPathOverride: tarball,
        manifestPathOverride: manifestPath,
        skillsDirOverride: skillsDir,
      })

      const skillMd = await readFile(path.join(skillsDir, "officecli-foo", "SKILL.md"), "utf8")
      expect(skillMd).toContain("PawWork-specific note")
      expect(skillMd).toContain("# Body")

      const editing = await readFile(path.join(skillsDir, "officecli-foo", "editing.md"), "utf8")
      expect(editing).toBe("edit guide body")

      const styles = await readFile(
        path.join(skillsDir, "officecli-foo", "reference", "styles", "INDEX.md"),
        "utf8",
      )
      expect(styles).toBe("styles index")
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
      await rm(path.dirname(manifestPath), { recursive: true, force: true })
      await rm(path.dirname(tarball), { recursive: true, force: true })
    }
  })

  test("default mode removes stale companion docs left over from a previous sync", async () => {
    // First sync ships one companion file; second sync drops it from the tarball.
    const skillsDir = await mkdtemp(path.join(tmpdir(), "sync-dest-stale-"))
    const manifestPath = await makeTempManifest({
      repo: "iOfficeAI/OfficeCLI",
      version: "v0.0.0-fixture",
    })

    const firstTarball = await buildFixtureTarball("repo-sha", {
      "skills/officecli-foo/SKILL.md": "---\nname: foo\n---\n",
      "skills/officecli-foo/old-companion.md": "stale",
    })

    try {
      await syncSkills({
        computeSha: true,
        tarballPathOverride: firstTarball,
        manifestPathOverride: manifestPath,
        skillsDirOverride: skillsDir,
      })
      await syncSkills({
        tarballPathOverride: firstTarball,
        manifestPathOverride: manifestPath,
        skillsDirOverride: skillsDir,
      })
      // confirm baseline
      expect((await readFile(path.join(skillsDir, "officecli-foo", "old-companion.md"), "utf8"))).toBe("stale")

      const secondTarball = await buildFixtureTarball("repo-sha", {
        "skills/officecli-foo/SKILL.md": "---\nname: foo\n---\n",
        // old-companion.md intentionally removed
      })
      await syncSkills({
        computeSha: true,
        tarballPathOverride: secondTarball,
        manifestPathOverride: manifestPath,
        skillsDirOverride: skillsDir,
      })
      await syncSkills({
        tarballPathOverride: secondTarball,
        manifestPathOverride: manifestPath,
        skillsDirOverride: skillsDir,
      })

      await expect(
        readFile(path.join(skillsDir, "officecli-foo", "old-companion.md"), "utf8"),
      ).rejects.toThrow(/ENOENT/)
      await rm(path.dirname(secondTarball), { recursive: true, force: true })
    } finally {
      await rm(skillsDir, { recursive: true, force: true })
      await rm(path.dirname(manifestPath), { recursive: true, force: true })
      await rm(path.dirname(firstTarball), { recursive: true, force: true })
    }
  })
})
