import { describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failingProfileBundle, removeProfileBundle } from "./dsh-profile-repair"

// The exact shape DSH dies with when a market install left a bundle behind.
const MISSING_OUTPUT = [
  "file:///app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:523",
  "\tthrow new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation`);",
  "",
  "Error: dsh: cannot resolve profile bundle \"dsh-lark-bot\" from the dsh installation or /home/u/.pawwork/dsh/profiles/web;"
    + " run 'dsh plugin --profile web install' if its dependency is not installed",
  "    at resolveBundleDir (file:///app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:523:8)",
].join("\n")

// The shape a plugin built against a removed DSH export dies with: the package
// is installed, the loader entry just cannot be imported. `better-sidebar` is
// the entry id and `dsh-better-sidebar` the package, and only the package is
// ever a bundle.
const INCOMPATIBLE_OUTPUT = [
  "Error: failed to import loader entry better-sidebar (dsh-better-sidebar):"
    + " The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'",
  "    at updateError (file:///app/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:309:9)",
  "  [cause]: file:///home/u/.pawwork/dsh/profiles/web/node_modules/dsh-better-sidebar/lib/index.js:11",
  "  import { SettingsConflictError, settingsNamespace } from \"@deepseek-ai/dsh-settings\";",
  "           ^^^^^^^^^^^^^^^^^^",
  "  SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'",
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

describe("failingProfileBundle", () => {
  test("names the bundle DSH could not resolve", () => {
    expect(failingProfileBundle(MISSING_OUTPUT)).toEqual({ bundle: "dsh-lark-bot", cause: "missing" })
  })

  test("names the package behind a loader entry that would not import", () => {
    expect(failingProfileBundle(INCOMPATIBLE_OUTPUT)).toEqual({ bundle: "dsh-better-sidebar", cause: "incompatible" })
  })

  test("takes the package in parentheses, not the entry id in front of it", () => {
    const failure = failingProfileBundle("Error: failed to import loader entry better-sidebar (dsh-better-sidebar): boom")
    expect(failure?.bundle).not.toBe("better-sidebar")
    expect(failure?.bundle).toBe("dsh-better-sidebar")
  })

  test("reads a scoped package name", () => {
    expect(failingProfileBundle("Error: failed to import loader entry modsearch (@liustack/modsearch): boom"))
      .toEqual({ bundle: "@liustack/modsearch", cause: "incompatible" })
  })

  // A start can bring down several plugins at once, and the loader reports the
  // group that held them before it reports either one. Naming the first real
  // package is enough: removing it and restarting re-attributes to the next.
  test("skips the loader's own wrapper entry and names the first failing package", () => {
    const aggregate = [
      "Error: failed to apply loader entry include (cordis:include): loader entries failed to apply",
      "    at Include._apply (file:///app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:240:3)",
      "  [cause]: AggregateError: loader entries failed to apply",
      "      [errors]: [",
      "        Error: failed to import loader entry better-sidebar (dsh-better-sidebar): no export 'settingsNamespace',",
      "        Error: failed to import loader entry llm-subscriptions (dsh-plugin-subscriptions): no export 'CallId'",
      "      ]",
    ].join("\n")

    expect(failingProfileBundle(aggregate)).toEqual({ bundle: "dsh-better-sidebar", cause: "incompatible" })
  })

  // The wrapper alone names nothing that could be dropped from the manifest, so
  // offering to remove it would be a button that cannot work.
  test("ignores the wrapper entry when no package is named", () => {
    expect(failingProfileBundle("Error: failed to apply loader entry include (cordis:include): boom")).toBeUndefined()
  })

  test("returns undefined for unrelated failures", () => {
    expect(failingProfileBundle("Error: listen EADDRINUSE: address already in use")).toBeUndefined()
    expect(failingProfileBundle("")).toBeUndefined()
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
