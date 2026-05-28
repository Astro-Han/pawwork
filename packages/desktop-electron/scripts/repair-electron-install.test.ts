import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isElectronInstallComplete,
  platformPathForElectron,
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
})
