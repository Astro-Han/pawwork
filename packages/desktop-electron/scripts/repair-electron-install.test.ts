import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isElectronInstallComplete,
  platformPathForElectron,
  repairElectronInstallAt,
  writeElectronPathFileIfInstallComplete,
} from "./repair-electron-install.mjs"

describe("repair Electron install", () => {
  test("uses the macOS Electron executable path", () => {
    expect(platformPathForElectron("darwin")).toBe("Electron.app/Contents/MacOS/Electron")
  })

  test("does not treat a macOS install as complete when the framework is missing", () => {
    const electronDir = mkdtempSync(join(tmpdir(), "pawwork-electron-install-"))
    const platformPath = platformPathForElectron("darwin")
    mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true })
    writeFileSync(join(electronDir, "dist", platformPath), "")

    expect(isElectronInstallComplete(electronDir, "darwin")).toBe(false)
    expect(writeElectronPathFileIfInstallComplete(electronDir, "darwin")).toBe(false)
  })

  test("writes path.txt when the Electron install is complete", () => {
    const electronDir = mkdtempSync(join(tmpdir(), "pawwork-electron-install-"))
    const platformPath = platformPathForElectron("darwin")
    mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true })
    mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "Frameworks", "Electron Framework.framework"), {
      recursive: true,
    })
    writeFileSync(join(electronDir, "dist", platformPath), "")
    writeFileSync(
      join(electronDir, "dist", "Electron.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"),
      "",
    )

    expect(isElectronInstallComplete(electronDir, "darwin")).toBe(true)
    expect(writeElectronPathFileIfInstallComplete(electronDir, "darwin")).toBe(true)
    expect(readFileSync(join(electronDir, "path.txt"), "utf8")).toBe(platformPath)
  })

  test("clears an incomplete Electron dist before reinstalling", () => {
    const electronDir = mkdtempSync(join(tmpdir(), "pawwork-electron-install-"))
    const platformPath = platformPathForElectron("darwin")
    mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true })
    writeFileSync(join(electronDir, "dist", platformPath), "")
    writeFileSync(join(electronDir, "path.txt"), platformPath)

    repairElectronInstallAt(electronDir, {
      platform: "darwin",
      runInstall() {
        expect(existsSync(join(electronDir, "dist"))).toBe(false)
        mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true })
        mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "Frameworks", "Electron Framework.framework"), {
          recursive: true,
        })
        writeFileSync(join(electronDir, "dist", platformPath), "")
        writeFileSync(
          join(
            electronDir,
            "dist",
            "Electron.app",
            "Contents",
            "Frameworks",
            "Electron Framework.framework",
            "Electron Framework",
          ),
          "",
        )
      },
    })

    expect(isElectronInstallComplete(electronDir, "darwin")).toBe(true)
    expect(readFileSync(join(electronDir, "path.txt"), "utf8")).toBe(platformPath)
  })

  test("retries without the Electron artifact cache when reinstall stays incomplete", () => {
    const electronDir = mkdtempSync(join(tmpdir(), "pawwork-electron-install-"))
    const platformPath = platformPathForElectron("darwin")
    const attempts: boolean[] = []

    repairElectronInstallAt(electronDir, {
      platform: "darwin",
      runInstall(_installScript, options) {
        attempts.push(options.forceNoCache)
        mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true })
        writeFileSync(join(electronDir, "dist", platformPath), "")

        if (options.forceNoCache) {
          mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "Frameworks", "Electron Framework.framework"), {
            recursive: true,
          })
          writeFileSync(
            join(
              electronDir,
              "dist",
              "Electron.app",
              "Contents",
              "Frameworks",
              "Electron Framework.framework",
              "Electron Framework",
            ),
            "",
          )
        }
      },
    })

    expect(attempts).toEqual([false, true])
    expect(isElectronInstallComplete(electronDir, "darwin")).toBe(true)
  })

  test("retries without the Electron artifact cache when the first reinstall fails", () => {
    const electronDir = mkdtempSync(join(tmpdir(), "pawwork-electron-install-"))
    const platformPath = platformPathForElectron("darwin")
    const attempts: boolean[] = []

    repairElectronInstallAt(electronDir, {
      platform: "darwin",
      runInstall(_installScript, options) {
        attempts.push(options.forceNoCache)
        if (!options.forceNoCache) throw new Error("cached artifact unavailable")

        mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true })
        mkdirSync(join(electronDir, "dist", "Electron.app", "Contents", "Frameworks", "Electron Framework.framework"), {
          recursive: true,
        })
        writeFileSync(join(electronDir, "dist", platformPath), "")
        writeFileSync(
          join(
            electronDir,
            "dist",
            "Electron.app",
            "Contents",
            "Frameworks",
            "Electron Framework.framework",
            "Electron Framework",
          ),
          "",
        )
      },
    })

    expect(attempts).toEqual([false, true])
    expect(isElectronInstallComplete(electronDir, "darwin")).toBe(true)
  })
})
