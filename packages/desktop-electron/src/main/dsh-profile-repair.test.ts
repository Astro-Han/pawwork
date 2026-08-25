import { describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeProfileBundle, unresolvedProfileBundle } from "./dsh-profile-repair"

// The exact shape DSH dies with when a market install left a bundle behind.
const FAILURE_OUTPUT = [
  "file:///app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:523",
  "\tthrow new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation`);",
  "",
  "Error: dsh: cannot resolve profile bundle \"dsh-lark-bot\" from the dsh installation or /home/u/.pawwork/dsh/profiles/web;"
    + " run 'dsh plugin --profile web install' if its dependency is not installed",
  "    at resolveBundleDir (file:///app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:523:8)",
].join("\n")

function profileDirWith(manifest: unknown) {
  const profileDir = mkdtempSync(join(tmpdir(), "pawwork-profile-repair-"))
  writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest), "utf8")
  return profileDir
}

function manifestOf(profileDir: string) {
  return JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
}

describe("unresolvedProfileBundle", () => {
  test("names the bundle DSH could not resolve", () => {
    expect(unresolvedProfileBundle(FAILURE_OUTPUT)).toBe("dsh-lark-bot")
  })

  test("returns undefined for unrelated failures", () => {
    expect(unresolvedProfileBundle("Error: listen EADDRINUSE: address already in use")).toBeUndefined()
    expect(unresolvedProfileBundle("")).toBeUndefined()
  })
})

describe("removeProfileBundle", () => {
  test("drops the named bundle and leaves the dependency entry alone", () => {
    const profileDir = profileDirWith({
      name: "dsh-profile-web",
      dependencies: { dshmarket: "1.21.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-lark-bot", "dshmarket"] } },
    })

    expect(removeProfileBundle({ profileDir, bundle: "dsh-lark-bot" })).toBe(true)
    expect(manifestOf(profileDir).dsh?.profile?.bundles).toEqual(["@deepseek-ai/dsh-base", "dshmarket"])
    expect(manifestOf(profileDir).dependencies).toEqual({ dshmarket: "1.21.0" })
  })

  test("does not rewrite the manifest when the bundle is absent", () => {
    const profileDir = profileDirWith({
      name: "dsh-profile-web",
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    })
    const before = readFileSync(join(profileDir, "package.json"), "utf8")

    expect(removeProfileBundle({ profileDir, bundle: "dsh-lark-bot" })).toBe(false)
    expect(readFileSync(join(profileDir, "package.json"), "utf8")).toBe(before)
  })

  test("does not rewrite the manifest when it declares no bundles", () => {
    const profileDir = profileDirWith({ name: "dsh-profile-web" })
    const before = readFileSync(join(profileDir, "package.json"), "utf8")

    expect(removeProfileBundle({ profileDir, bundle: "dsh-lark-bot" })).toBe(false)
    expect(readFileSync(join(profileDir, "package.json"), "utf8")).toBe(before)
  })
})
