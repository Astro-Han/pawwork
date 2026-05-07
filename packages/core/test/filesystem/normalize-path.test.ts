import { test, expect } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

// All Windows variants below collapse to the same canonical form on Windows.
// On macOS/Linux normalizePath is the identity function, so we keep the
// Windows-only guards explicit to avoid accidental cross-platform skew.

test("normalizePath is identity on non-Windows", () => {
  if (process.platform === "win32") return
  const p = "/usr/local/bin/foo"
  expect(AppFileSystem.normalizePath(p)).toBe(p)
})

function withWin32Platform(fn: () => void) {
  const original = process.platform
  Object.defineProperty(process, "platform", { value: "win32" })
  try {
    fn()
  } finally {
    Object.defineProperty(process, "platform", { value: original })
  }
}

test("normalizePath folds extended-length drive paths on Windows", () => {
  withWin32Platform(() => {
    expect(AppFileSystem.normalizePath("\\\\?\\D:\\Users\\Ada\\file.txt")).toBe("D:\\Users\\Ada\\file.txt")
  })
})

test("normalizePath folds extended-length UNC paths on Windows", () => {
  withWin32Platform(() => {
    expect(AppFileSystem.normalizePath("\\\\?\\UNC\\server\\share\\dir\\file.txt")).toBe(
      "\\\\server\\share\\dir\\file.txt",
    )
  })
})

test("normalizeWindowsPath resolves non-existing rooted-driveless paths from an explicit base drive", () => {
  expect(AppFileSystem.normalizeWindowsPath("\\future\\file.txt", { base: "D:\\project\\work" })).toBe(
    "D:\\future\\file.txt",
  )
})

test("normalizeWindowsPath uppercases drive letters for non-existing drive-qualified paths", () => {
  expect(AppFileSystem.normalizeWindowsPath("d:\\future\\file.txt")).toBe("D:\\future\\file.txt")
})

test("normalizeWindowsPath rejects ambiguous rooted-driveless existing paths", () => {
  expect(() =>
    AppFileSystem.normalizeWindowsPath("\\shared\\file.txt", {
      driveRoots: ["C:\\", "D:\\"],
      exists: (candidate) =>
        candidate.toLowerCase() === "c:\\shared\\file.txt" || candidate.toLowerCase() === "d:\\shared\\file.txt",
    }),
  ).toThrow("Ambiguous Windows path")
})

test.skipIf(process.platform !== "win32")(
  "normalizePath probes drive roots for rooted-but-driveless paths to existing files",
  () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pawwork-fs-"))
    try {
      const file = path.join(tmpdir, "marker.txt")
      fs.writeFileSync(file, "x")

      const driveless = file.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/").toLowerCase()
      const result = AppFileSystem.normalizePath(driveless)

      expect(result.toLowerCase()).toBe(file.toLowerCase())
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "normalizePath canonicalizes Git Bash /c/... style paths",
  () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pawwork-fs-"))
    try {
      const file = path.join(tmpdir, "marker.txt")
      fs.writeFileSync(file, "x")

      const drive = file.match(/^([A-Za-z]):/)![1].toLowerCase()
      const tail = file.slice(2).replaceAll("\\", "/")
      const gitBash = `/${drive}${tail}`
      const result = AppFileSystem.normalizePath(gitBash)

      expect(result.toLowerCase()).toBe(file.toLowerCase())
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "normalizePath canonicalizes Cygwin /cygdrive/c/... paths",
  () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pawwork-fs-"))
    try {
      const file = path.join(tmpdir, "marker.txt")
      fs.writeFileSync(file, "x")

      const drive = file.match(/^([A-Za-z]):/)![1].toLowerCase()
      const tail = file.slice(2).replaceAll("\\", "/")
      const cygwin = `/cygdrive/${drive}${tail}`
      const result = AppFileSystem.normalizePath(cygwin)

      expect(result.toLowerCase()).toBe(file.toLowerCase())
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "normalizePath canonicalizes WSL /mnt/c/... paths",
  () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pawwork-fs-"))
    try {
      const file = path.join(tmpdir, "marker.txt")
      fs.writeFileSync(file, "x")

      const drive = file.match(/^([A-Za-z]):/)![1].toLowerCase()
      const tail = file.slice(2).replaceAll("\\", "/")
      const wsl = `/mnt/${drive}${tail}`
      const result = AppFileSystem.normalizePath(wsl)

      expect(result.toLowerCase()).toBe(file.toLowerCase())
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "normalizePath leaves drive-prefixed paths intact for already-canonical input",
  () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pawwork-fs-"))
    try {
      const file = path.join(tmpdir, "marker.txt")
      fs.writeFileSync(file, "x")

      const result = AppFileSystem.normalizePath(file)
      expect(result.toLowerCase()).toBe(file.toLowerCase())
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "normalizePath falls back to cwd-drive resolution for non-existent rooted-driveless paths",
  () => {
    // The probe only repairs existing paths; documenting behavior so future
    // changes don't accidentally start guessing for write targets.
    const driveless = "/this/path/should/not/exist/anywhere/marker.txt"
    const cwdDrive = process.cwd().match(/^([A-Za-z]:)/)![1].toUpperCase()
    const expected = path.win32.normalize(path.win32.join(`${cwdDrive}\\`, driveless.replaceAll("/", "\\")))
    const result = AppFileSystem.normalizePath(driveless)

    expect(result.toUpperCase()).toBe(expected.toUpperCase())
  },
)

test.skipIf(process.platform !== "win32")(
  "normalizePathPattern preserves trailing /* glob",
  () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pawwork-fs-"))
    try {
      const driveless = tmpdir.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/").toLowerCase()
      const pattern = AppFileSystem.normalizePathPattern(`${driveless}/*`)

      expect(pattern.endsWith("\\*") || pattern.endsWith("/*")).toBe(true)
      expect(pattern.toLowerCase()).toContain(tmpdir.toLowerCase())
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true })
    }
  },
)
