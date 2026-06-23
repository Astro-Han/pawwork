import { link, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

const REPORT_FILE_PATTERN = /^pawwork-problem-report-\d{8}-\d{6}-\d{3}-[a-zA-Z0-9_]+\.json$/
const REPORT_ID_PATTERN = /^[a-zA-Z0-9_]+$/

function isCanonicalIsoTimestamp(value: string) {
  const time = Date.parse(value)
  return !Number.isNaN(time) && new Date(time).toISOString() === value
}

export function problemReportFileName(input: { reportId: string; generatedAt: string }) {
  if (!REPORT_ID_PATTERN.test(input.reportId)) throw new Error("reportId must contain only letters, numbers, and underscores")
  if (!isCanonicalIsoTimestamp(input.generatedAt)) throw new Error("generatedAt must be a valid ISO timestamp")
  const date = new Date(input.generatedAt)
  const stamp = [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
    "-",
    String(date.getMilliseconds()).padStart(3, "0"),
  ].join("")
  return `pawwork-problem-report-${stamp}-${input.reportId}.json`
}

export function problemReportsRoot(userDataPath: string) {
  return join(userDataPath, "problem-reports")
}

export function reportLocationHint(input: { fileName: string; platform: NodeJS.Platform | string }) {
  const root = input.platform === "win32" ? "%APPDATA%" : "PawWork app data"
  return `${root}/.../problem-reports/${input.fileName}`
}

export async function writeProblemReportFile(input: {
  root: string
  reportId: string
  generatedAt: string
  json: string
  removeTemp?: (path: string) => Promise<void>
}) {
  await mkdir(input.root, { recursive: true })
  const fileName = problemReportFileName({ reportId: input.reportId, generatedAt: input.generatedAt })
  const path = join(input.root, fileName)
  const tempPath = join(input.root, `.${fileName}.${process.pid}.${Date.now()}.tmp`)
  const removeTemp = input.removeTemp ?? ((path: string) => rm(path, { force: true }))
  try {
    await writeFile(tempPath, input.json, { encoding: "utf8", flag: "wx", mode: 0o600 })
    try {
      await link(tempPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Problem report already exists")
      throw error
    }
    await removeTemp(tempPath).catch(() => undefined)
    return {
      path,
      fileName,
      locationHint: reportLocationHint({ fileName, platform: process.platform }),
    }
  } catch (error) {
    await removeTemp(tempPath).catch(() => undefined)
    throw error
  }
}

export async function cleanupProblemReports(input: { root: string; keep: number; currentPath: string }) {
  let entries: Array<{ path: string; mtimeMs: number }> = []
  try {
    const names = await readdir(input.root)
    for (const name of names) {
      if (!REPORT_FILE_PATTERN.test(name)) continue
      const path = join(input.root, name)
      if (path === input.currentPath) continue
      try {
        const stat = await lstat(path)
        if (!stat.isFile()) continue
        entries.push({ path, mtimeMs: stat.mtimeMs })
      } catch {
        continue
      }
    }
  } catch {
    return
  }

  entries = entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const retainedArchivedReports = Math.max(0, input.keep - 1)
  for (const entry of entries.slice(retainedArchivedReports)) {
    await rm(entry.path, { force: true }).catch(() => undefined)
  }
}

export function isProblemReportFileName(name: string) {
  return REPORT_FILE_PATTERN.test(basename(name))
}
