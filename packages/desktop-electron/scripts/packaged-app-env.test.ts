import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { packagedAppEnv } from "./packaged-app-env.ts"

const workflows = join(import.meta.dirname, "..", "..", "..", ".github", "workflows")

describe("packaged app locations", () => {
  test("names the bundle and its executable per channel and platform", () => {
    expect(packagedAppEnv("prod", "darwin", "arm64")).toEqual({
      APP_NAME: "PawWork",
      APP_OUT_DIR: "dist/mac-arm64",
      APP_PATH: "dist/mac-arm64/PawWork.app",
      EXECUTABLE_PATH: "dist/mac-arm64/PawWork.app/Contents/MacOS/PawWork",
    })
    expect(packagedAppEnv("dev", "darwin", "x64")).toEqual({
      APP_NAME: "PawWork Dev",
      APP_OUT_DIR: "dist/mac",
      APP_PATH: "dist/mac/PawWork Dev.app",
      EXECUTABLE_PATH: "dist/mac/PawWork Dev.app/Contents/MacOS/PawWork Dev",
    })
    // Windows has no per-arch directory and the executable is the app itself.
    expect(packagedAppEnv("beta", "win32", "x64")).toEqual({
      APP_NAME: "PawWork Beta",
      APP_OUT_DIR: "dist/win-unpacked",
      APP_PATH: "dist/win-unpacked/PawWork Beta.exe",
      EXECUTABLE_PATH: "dist/win-unpacked/PawWork Beta.exe",
    })
  })

  test("refuses a channel, platform or arch it does not package", () => {
    expect(() => packagedAppEnv("nightly", "darwin", "arm64")).toThrow("Unsupported channel: nightly")
    expect(() => packagedAppEnv("prod", "linux", "x64")).toThrow("Unsupported platform: linux")
    expect(() => packagedAppEnv("prod", "darwin", "ia32")).toThrow("Unsupported arch: ia32")
  })

  // The point of the resolver is that CI stops restating what it knows. A copy
  // that creeps back in would be silent — the workflow only runs on a release —
  // so the absence is asserted here instead.
  test("no workflow spells out an app bundle name or output directory", () => {
    for (const file of ["build.yml", "desktop-smoke.yml"]) {
      const workflow = readFileSync(join(workflows, file), "utf8")
      expect(workflow).not.toMatch(/APP_NAME="PawWork/)
      expect(workflow).not.toMatch(/APP_OUT_DIR="dist\//)
      expect(workflow).not.toMatch(/dist\/(mac|mac-arm64|win-unpacked)\/PawWork/)
    }
  })
})
