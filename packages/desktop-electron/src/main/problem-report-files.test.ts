import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupProblemReports,
  problemReportFileName,
  reportLocationHint,
  writeProblemReportFile,
} from "./problem-report-files"

let tempRoots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pawwork-report-files-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true })
  tempRoots = []
})

describe("problem report files", () => {
  test("builds collision-resistant JSON file names in local time", () => {
    const generatedAt = new Date(2026, 3, 23, 9, 2, 3, 4).toISOString()
    const first = problemReportFileName({
      reportId: "pwr_abc123",
      generatedAt,
    })
    const second = problemReportFileName({
      reportId: "pwr_def456",
      generatedAt,
    })

    expect(first).toBe("pawwork-problem-report-20260423-090203-004-pwr_abc123.json")
    expect(second).toBe("pawwork-problem-report-20260423-090203-004-pwr_def456.json")
  })

  test("rejects report ids that cannot be cleaned up safely", () => {
    for (const reportId of ["../escape", "pwr-bad", "pwr.bad", "pwr bad", "pwr/bad"]) {
      expect(() =>
        problemReportFileName({
          reportId,
          generatedAt: "2026-04-23T01:02:03.004Z",
        }),
      ).toThrow("reportId must contain only letters, numbers, and underscores")
    }
  })

  test("rejects non-canonical generated timestamps", () => {
    for (const generatedAt of ["not a date", "2026-04-23", "2026-04-23T01:02:03Z"]) {
      expect(() =>
        problemReportFileName({
          reportId: "pwr_abc123",
          generatedAt,
        }),
      ).toThrow("generatedAt must be a valid ISO timestamp")
    }
  })

  test("writes through a temporary file and does not overwrite existing reports", async () => {
    const root = await tempRoot()
    const first = await writeProblemReportFile({
      root,
      reportId: "pwr_abc123",
      generatedAt: "2026-04-23T01:02:03.004Z",
      json: "first",
    })
    await expect(
      writeProblemReportFile({
        root,
        reportId: "pwr_abc123",
        generatedAt: "2026-04-23T01:02:03.004Z",
        json: "second",
      }),
    ).rejects.toThrow("Problem report already exists")

    expect(await readFile(first.path, "utf8")).toBe("first")
  })

  test("keeps the saved report usable when temporary cleanup fails after linking", async () => {
    const root = await tempRoot()
    let cleanupAttempted = false
    const report = await writeProblemReportFile({
      root,
      reportId: "pwr_cleanup_failed",
      generatedAt: "2026-04-23T01:02:03.004Z",
      json: "report",
      removeTemp: async () => {
        cleanupAttempted = true
        throw new Error("cleanup failed")
      },
    })

    expect(cleanupAttempted).toBe(true)
    expect(await readFile(report.path, "utf8")).toBe("report")
  })

  test("creates a user-facing location hint without full local paths", () => {
    expect(
      reportLocationHint({
        fileName: "pawwork-problem-report-20260423-010203-004-pwr_abc123.json",
        platform: "darwin",
      }),
    ).toBe("PawWork app data/.../problem-reports/pawwork-problem-report-20260423-010203-004-pwr_abc123.json")
    expect(
      reportLocationHint({
        fileName: "pawwork-problem-report-20260423-010203-004-pwr_abc123.json",
        platform: "win32",
      }),
    ).toBe("%APPDATA%/.../problem-reports/pawwork-problem-report-20260423-010203-004-pwr_abc123.json")
  })

  test("cleanup keeps current report and skips non-regular or non-matching entries", async () => {
    const root = await tempRoot()
    const current = await writeProblemReportFile({
      root,
      reportId: "pwr_current",
      generatedAt: "2026-04-23T01:02:03.004Z",
      json: "current",
    })
    const old = join(root, "pawwork-problem-report-20260423-010203-004-pwr_old.json")
    const other = join(root, "notes.md")
    const dir = join(root, "pawwork-problem-report-20260423-010203-004-pwr_dir.json")
    const link = join(root, "pawwork-problem-report-20260423-010203-004-pwr_link.json")
    await writeFile(old, "old")
    await writeFile(other, "other")
    await mkdir(dir)
    await symlink(other, link)

    await cleanupProblemReports({ root, keep: 1, currentPath: current.path })

    expect(existsSync(current.path)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(link)).toBe(true)
    expect(existsSync(old)).toBe(false)
  })

  test("cleanup keep count includes the current report", async () => {
    const root = await tempRoot()
    const current = await writeProblemReportFile({
      root,
      reportId: "pwr_current",
      generatedAt: "2026-04-23T01:02:03.004Z",
      json: "current",
    })
    const newestArchived = join(root, "pawwork-problem-report-20260423-010203-004-pwr_newest.json")
    const oldestArchived = join(root, "pawwork-problem-report-20260423-010203-004-pwr_oldest.json")
    await writeFile(newestArchived, "newest")
    await writeFile(oldestArchived, "oldest")

    const newestTime = new Date("2026-04-23T01:02:06.004Z")
    const oldestTime = new Date("2026-04-23T01:02:04.004Z")
    await Promise.all([utimes(newestArchived, newestTime, newestTime), utimes(oldestArchived, oldestTime, oldestTime)])

    await cleanupProblemReports({ root, keep: 2, currentPath: current.path })

    expect(existsSync(current.path)).toBe(true)
    expect(existsSync(newestArchived)).toBe(true)
    expect(existsSync(oldestArchived)).toBe(false)
  })

  test("cleanup removes legacy Markdown reports without matching ordinary Markdown files", async () => {
    const root = await tempRoot()
    const current = await writeProblemReportFile({
      root,
      reportId: "pwr_current",
      generatedAt: "2026-04-23T01:02:03.004Z",
      json: "current",
    })
    const legacyReport = join(root, "pawwork-problem-report-20260423-010203-004-pwr_legacy.md")
    const ordinaryMarkdown = join(root, "notes.md")
    await writeFile(legacyReport, "legacy")
    await writeFile(ordinaryMarkdown, "notes")

    await cleanupProblemReports({ root, keep: 1, currentPath: current.path })

    expect(existsSync(current.path)).toBe(true)
    expect(existsSync(legacyReport)).toBe(false)
    expect(existsSync(ordinaryMarkdown)).toBe(true)
  })
})
