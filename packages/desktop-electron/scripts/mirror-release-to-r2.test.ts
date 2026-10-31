import { describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { load } from "js-yaml"
import { join } from "node:path"

import { releaseAssetNames } from "./verify-release.ts"
import {
  buildManifest,
  cleanupPlan,
  missingPointerReferences,
  pointerReferencedAssets,
  uploadPlan,
} from "./mirror-release-to-r2.ts"
import { RELEASE_TARGETS } from "./release-targets.ts"

describe("buildManifest", () => {
  test("locks the manifest shape and per-platform installer URLs", () => {
    expect(buildManifest("2026.5.29", "https://dl.pawwork.ai")).toEqual({
      version: "2026.5.29",
      macArm64: "https://dl.pawwork.ai/pawwork-mac-arm64-2026.5.29.dmg",
      macX64: "https://dl.pawwork.ai/pawwork-mac-x64-2026.5.29.dmg",
      winX64: "https://dl.pawwork.ai/pawwork-win-x64-2026.5.29.exe",
    })
  })

  // The landing page swaps its download buttons to R2 links by reading these
  // keys out of latest.json. They are matched by name across two directories,
  // so a renamed key would only surface as a button that never updates.
  test("offers exactly the keys the download buttons look up", () => {
    const home = readFileSync(join(import.meta.dirname, "..", "..", "..", "site", "src", "components", "Home.astro"), "utf8")
    const buttons = new Set([...home.matchAll(/data-dl="(\w+)"/g)].map((match) => match[1]))
    const manifest = buildManifest("2026.5.29", "https://dl.pawwork.ai")

    expect(buttons).toEqual(new Set(RELEASE_TARGETS.map((target) => target.manifestKey)))
    for (const key of buttons) expect(Object.keys(manifest)).toContain(key)
  })

  test("normalizes a trailing slash in the public base", () => {
    expect(buildManifest("2026.5.29", "https://dl.pawwork.ai/").macArm64).toBe(
      "https://dl.pawwork.ai/pawwork-mac-arm64-2026.5.29.dmg",
    )
  })
})

describe("R2 installer retention", () => {
  const base = "https://dl.pawwork.ai"
  const versions = ["2026.8.5", "2026.9.13", "2026.10.1"]
  const objects = versions.flatMap((version) => releaseAssetNames(version)
    .filter((name) => name.startsWith("pawwork-"))
    .map((Key) => ({ Key, Size: 100 })))
  const metadata = (version: string, os: string) => `version: ${version}\nfiles:\n${RELEASE_TARGETS
    .filter((target) => target.os === os)
    .map((target) => `  - url: pawwork-${target.os}-${target.arch}-${version}.${target.updaterExt}`)
    .join("\n")}\n`
  const pointers = {
    "latest-mac.yml": metadata(versions[0], "mac"),
    "latest.yml": metadata(versions[0], "win"),
    "latest-v2-mac.yml": metadata(versions[2], "mac"),
    "latest-v2.yml": metadata(versions[2], "win"),
    "latest.json": JSON.stringify(buildManifest(versions[2], base)),
  }

  test("removes only superseded installers, preserving both channels, every blockmap and unrelated objects", () => {
    const inventory = [...objects, ...Object.keys(pointers).map((Key) => ({ Key, Size: 1 })),
      { Key: "other.dmg", Size: 1 }, { Key: "archive/pawwork-win-x64-2026.9.13.exe", Size: 1 }]
    expect(cleanupPlan(inventory, pointers, base)).toEqual([
      "pawwork-mac-arm64-2026.9.13.dmg",
      "pawwork-mac-arm64-2026.9.13.zip",
      "pawwork-mac-x64-2026.9.13.dmg",
      "pawwork-mac-x64-2026.9.13.zip",
      "pawwork-win-x64-2026.9.13.exe",
    ])
  })

  test("refuses cleanup when a channel, manifest or retained artifact is incomplete", () => {
    const withoutV1 = { ...pointers, "latest.yml": "" }
    expect(() => cleanupPlan(objects, withoutV1, base)).toThrow("Missing retention pointer")
    expect(() => cleanupPlan(objects, { ...pointers, "latest.yml": metadata(versions[1], "win") }, base)).toThrow("Channel version mismatch")
    expect(() => cleanupPlan(objects, { ...pointers, "latest.json": JSON.stringify(buildManifest(versions[1], base)) }, base)).toThrow("latest.json")
    expect(() => cleanupPlan(objects.filter((object) => !object.Key.endsWith("2026.8.5.zip")), pointers, base)).toThrow("Incomplete retained release")
    expect(() => cleanupPlan(objects, { ...pointers, "latest-v2.yml": "version: 2026.10.1\nfiles: []" }, base)).toThrow("Invalid retention references")
  })

  // Execute the real CLI at its AWS boundary, including the read-before-delete
  // check and post-delete inventory verification.
  function runCleanup(mode: "preview" | "apply" | "changed" | "error" | "stale") {
    const dir = mkdtempSync(join(tmpdir(), "r2-retention-test-"))
    const state = join(dir, "state.json")
    writeFileSync(state, JSON.stringify({ objects,
      pointers: mode === "stale" ? { ...pointers, "latest-v2.yml": metadata(versions[1], "win") } : pointers,
      calls: [], reads: 0 }))
    writeFileSync(join(dir, "gh"), "#!/bin/sh\necho 'Unexpected GitHub mutation or download' >&2\nexit 1\n", { mode: 0o755 })
    writeFileSync(join(dir, "aws"), `#!/usr/bin/env node
const fs = require('node:fs');
const state = process.env.RETENTION_TEST_STATE;
const mode = process.env.RETENTION_TEST_MODE;
const data = JSON.parse(fs.readFileSync(state, 'utf8'));
const args = process.argv.slice(2);
data.calls.push(args[1]);
if (args[1] === 'list-objects-v2') console.log(JSON.stringify({Contents: data.objects}));
else if (args[1] === 'get-object') {
  const key = args[args.indexOf('--key') + 1];
  data.reads++;
  let text = data.pointers[key];
  if (mode === 'changed' && data.reads > 5) text += '\\n';
  fs.writeFileSync(args[args.indexOf('--key') + 2], text);
  console.log('{}');
} else if (args[1] === 'delete-objects') {
  const keys = JSON.parse(args[args.indexOf('--delete') + 1]).Objects.map(o => o.Key);
  if (mode === 'error') console.log(JSON.stringify({Errors:[{Key:keys[0],Code:'AccessDenied'}]}));
  else { data.objects = data.objects.filter(o => !keys.includes(o.Key)); console.log('{}'); }
} else process.exitCode = 1;
fs.writeFileSync(state, JSON.stringify(data));
`, { mode: 0o755 })
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "mirror-release-to-r2.ts"),
        ...(mode === "stale" ? ["v2026.9.13"] : ["--cleanup-only"]), ...(mode === "preview" ? ["--dry-run"] : [])], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RETENTION_TEST_STATE: state,
          RETENTION_TEST_MODE: mode, R2_ACCOUNT_ID: "test", R2_BUCKET: "test", DOWNLOAD_PUBLIC_BASE: base,
          AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
      })
      return { ...result, data: JSON.parse(readFileSync(state, "utf8")) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("previews without deleting, applies and verifies, and leaves no further candidates", () => {
    const preview = runCleanup("preview")
    expect(preview.status, preview.stderr).toBe(0)
    expect(preview.stdout).toContain("Cleanup preview: 5 installers")
    expect(preview.data.calls).not.toContain("delete-objects")
    const applied = runCleanup("apply")
    expect(applied.status, applied.stderr).toBe(0)
    expect(applied.stdout).toContain("Cleanup verified: 5 installers removed")
    expect(cleanupPlan(applied.data.objects, pointers, base)).toEqual([])
  })

  test("refuses an old retry even when a newer mirror updated only the macOS pointer", () => {
    const stale = runCleanup("stale")
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain("Refusing to replace R2 version 2026.10.1 with older version 2026.9.13")
    expect(stale.data.calls).not.toContain("delete-objects")
  })

  test("never deletes after a pointer changes and reports per-object AWS deletion errors", () => {
    const changed = runCleanup("changed")
    expect(changed.status).toBe(1)
    expect(changed.stderr).toContain("Retention pointers changed")
    expect(changed.data.calls).not.toContain("delete-objects")
    const failed = runCleanup("error")
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain("AccessDenied")
    expect(failed.stdout).not.toContain("Cleanup verified")
  })
})

describe("uploadPlan", () => {
  const plan = uploadPlan(releaseAssetNames("2026.5.29"))
  const names = plan.map((step) => step.name)

  test("ends with the landing-page manifest as the single live switch", () => {
    expect(names.at(-1)).toBe("latest.json")
    expect(plan.at(-1)).toMatchObject({ manifest: true, cacheControl: "no-cache, must-revalidate" })
  })

  test("orders immutable versioned artifacts before the mutable updater pointers", () => {
    const lastVersioned = Math.max(
      names.indexOf("pawwork-mac-arm64-2026.5.29.dmg"),
      names.indexOf("pawwork-win-x64-2026.5.29.exe"),
      names.indexOf("pawwork-mac-arm64-2026.5.29.zip.blockmap"),
    )
    const firstPointer = Math.min(names.indexOf("latest-v2.yml"), names.indexOf("latest-v2-mac.yml"))
    expect(lastVersioned).toBeLessThan(firstPointer)
    expect(firstPointer).toBeLessThan(names.indexOf("latest.json"))
  })

  test("marks versioned artifacts immutable and pointers no-cache", () => {
    const cacheOf = (name: string) => plan.find((step) => step.name === name)?.cacheControl
    expect(cacheOf("pawwork-mac-arm64-2026.5.29.dmg")).toBe("public, max-age=31536000, immutable")
    expect(cacheOf("latest-v2.yml")).toBe("no-cache, must-revalidate")
    expect(cacheOf("latest-v2-mac.yml")).toBe("no-cache, must-revalidate")
  })

  test("uploads every released asset exactly once plus the manifest", () => {
    const assets = releaseAssetNames("2026.5.29")
    expect(names.slice(0, -1).sort()).toEqual([...assets].sort())
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("pointer reference alignment", () => {
  const latestMacYml = [
    "version: 2026.5.29",
    "files:",
    "  - url: pawwork-mac-arm64-2026.5.29.zip",
    "    sha512: abc",
    "    size: 123",
    "  - url: pawwork-mac-x64-2026.5.29.zip",
    "    sha512: def",
    "    size: 456",
    "path: pawwork-mac-arm64-2026.5.29.zip",
    "sha512: abc",
    "",
  ].join("\n")

  test("collects the deduped asset names a pointer references", () => {
    expect(pointerReferencedAssets(latestMacYml)).toEqual([
      "pawwork-mac-arm64-2026.5.29.zip",
      "pawwork-mac-x64-2026.5.29.zip",
    ])
  })

  test("reduces a full download URL to its asset name", () => {
    const yml = "files:\n  - url: https://example.com/d/pawwork-win-x64-2026.5.29.exe\npath: pawwork-win-x64-2026.5.29.exe\n"
    expect(pointerReferencedAssets(yml)).toEqual(["pawwork-win-x64-2026.5.29.exe"])
  })

  test("flags references the mirror would not upload", () => {
    const mirrored = new Set(releaseAssetNames("2026.5.29"))
    expect(missingPointerReferences(pointerReferencedAssets(latestMacYml), mirrored)).toEqual([])
    expect(missingPointerReferences(["pawwork-mac-arm64-9.9.9.zip"], mirrored)).toEqual([
      "pawwork-mac-arm64-9.9.9.zip",
    ])
  })
})

describe("mirror workflow shell-injection guard", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "mirror-release-to-r2.yml"),
    "utf8",
  )
  const workflow = load(source) as {
    concurrency: { group: string; "cancel-in-progress": boolean }
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>
  }

  test("never interpolates a GitHub expression into a run: script", () => {
    // An attacker-controlled tag must reach the secrets-bearing steps as data
    // ($TAG), never as shell text — ${{ }} inside a run: body allows injection.
    // Parsed rather than grepped: the previous line-based check only saw the
    // single-line form, so the ordinary `run: |` block scalar — where a real
    // multi-line script lives — was never looked at.
    const offending = Object.entries(workflow.jobs).flatMap(([job, definition]) =>
      (definition.steps ?? [])
        .map((step, index) => ({ label: `${job} step ${index}: ${step.name ?? "(unnamed)"}`, run: step.run }))
        .filter((step) => typeof step.run === "string" && step.run.includes("${{")),
    )
    expect(offending.map((step) => step.label)).toEqual([])
  })

  test("passes the tag to scripts via the quoted env var", () => {
    expect(source).toContain('verify-release.ts "$TAG"')
    expect(source).toContain('mirror-release-to-r2.ts "$TAG"')
  })

  test("serializes all bucket writes and routes manual cleanup without mirroring", () => {
    expect(workflow.concurrency).toEqual({ group: "mirror-r2-pawwork-downloads", "cancel-in-progress": false })
    const script = workflow.jobs.mirror.steps?.find((step) => step.name === "Mirror and clean R2")?.run
    if (!script) throw new Error("Missing mirror step")
    const dir = mkdtempSync(join(tmpdir(), "r2-workflow-test-"))
    writeFileSync(join(dir, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 })
    try {
      for (const [operation, args] of [
        ["mirror", "v2026.10.1"],
        ["preview-cleanup", "--cleanup-only --dry-run"],
        ["cleanup", "--cleanup-only"],
      ]) {
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: {
          ...process.env, PATH: `${dir}:${process.env.PATH}`, OPERATION: operation, TAG: "v2026.10.1",
        } })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe(`--filter @pawwork/desktop exec tsx scripts/mirror-release-to-r2.ts ${args}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
