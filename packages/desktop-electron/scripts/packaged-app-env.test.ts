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
    expect(packagedAppEnv("prod", "win32", "x64")).toEqual({
      APP_NAME: "PawWork",
      APP_OUT_DIR: "dist/win-unpacked",
      APP_PATH: "dist/win-unpacked/PawWork.exe",
      EXECUTABLE_PATH: "dist/win-unpacked/PawWork.exe",
    })
  })

  test("refuses a channel, platform or arch it does not package", () => {
    expect(() => packagedAppEnv("nightly", "darwin", "arm64")).toThrow("Unsupported channel: nightly")
    expect(() => packagedAppEnv("prod", "linux", "x64")).toThrow("Unsupported platform: linux")
    expect(() => packagedAppEnv("prod", "darwin", "ia32")).toThrow("Unsupported arch: ia32")
  })

  // build.yml only runs on a release dispatch, so nothing here has ever executed
  // it. What is checkable is the wiring: every variable the mac steps read comes
  // from this resolver, and every one of them is resolved before it is read.
  test("build.yml reads only variables the resolver publishes, and only after it runs", () => {
    const build = readFileSync(join(workflows, "build.yml"), "utf8")
    const steps = build.split(/\n {6}- name: /).slice(1)
    const published = new Set([
      ...Object.keys(packagedAppEnv("prod", "darwin", "arm64")),
      "PUBLISH_OWNER",
      "PUBLISH_REPO",
      "METADATA_FILE",
      "METADATA_ARTIFACT",
    ])

    const resolveIndex = steps.findIndex((step) => step.includes("packaged-app-env.ts"))
    expect(resolveIndex).toBeGreaterThanOrEqual(0)

    const readers = steps.flatMap((step, index) =>
      [...step.matchAll(/\$(APP_NAME|APP_OUT_DIR|APP_PATH|EXECUTABLE_PATH|PUBLISH_OWNER|PUBLISH_REPO|METADATA_FILE|METADATA_ARTIFACT)\b/g)]
        .map((match) => ({ index, name: match[1] })),
    )

    expect(readers.length).toBeGreaterThan(0)
    for (const reader of readers) {
      expect(published, `${reader.name} is read but never published`).toContain(reader.name)
      expect(reader.index, `${reader.name} is read before the resolver runs`).toBeGreaterThan(resolveIndex)
    }
  })

  // The point of the resolver is that CI stops restating what it knows. A copy
  // that creeps back in would be silent — the workflow only runs on a release —
  // so the absence is asserted here instead.
  test("no workflow spells out an app bundle name, output directory or metadata artifact", () => {
    for (const file of ["build.yml", "ci.yml"]) {
      const workflow = readFileSync(join(workflows, file), "utf8")
      expect(workflow).not.toMatch(/APP_NAME="PawWork/)
      expect(workflow).not.toMatch(/APP_OUT_DIR="dist\//)
      expect(workflow).not.toMatch(/dist\/(mac|mac-arm64|win-unpacked)\/PawWork/)
      // A renamed metadata artifact fails silently — the finalizer reads a
      // directory nothing wrote and exits 0 having finalized nothing.
      expect(workflow).not.toMatch(/latest-yml-[a-z0-9_]+-/)
      expect(workflow).not.toMatch(/\blatest(-mac)?\.yml\b/)
    }
  })
})
