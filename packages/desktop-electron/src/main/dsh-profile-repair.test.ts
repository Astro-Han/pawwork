import { describe, expect, test } from "vitest"
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

function manifest(bundles: string[]) {
  return JSON.stringify({
    name: "dsh-profile-web",
    dependencies: { dshmarket: "1.21.0" },
    dsh: { profile: { bundles } },
  })
}

describe("unresolvedProfileBundle", () => {
  test("names the bundle DSH could not resolve", () => {
    expect(unresolvedProfileBundle(FAILURE_OUTPUT)).toBe("dsh-lark-bot")
  })

  test("reads the name from the error line, not the source echo above it", () => {
    // The thrown-source echo carries the uninterpolated template, so a greedy
    // pattern could match `${JSON.stringify(packageName)}` instead.
    expect(unresolvedProfileBundle(FAILURE_OUTPUT)).not.toContain("JSON")
  })

  test("returns undefined for unrelated failures", () => {
    expect(unresolvedProfileBundle("Error: listen EADDRINUSE: address already in use")).toBeUndefined()
    expect(unresolvedProfileBundle("")).toBeUndefined()
  })
})

describe("removeProfileBundle", () => {
  test("drops the named bundle and reports the change", () => {
    const written = new Map<string, string>()
    const changed = removeProfileBundle({
      profileDir: "/home/u/.pawwork/dsh/profiles/web",
      bundle: "dsh-lark-bot",
      read: () => manifest(["@deepseek-ai/dsh-base", "dsh-lark-bot", "dshmarket"]),
      write: (path, contents) => void written.set(path, contents),
    })

    expect(changed).toBe(true)
    const contents = written.get(join("/home/u/.pawwork/dsh/profiles/web", "package.json"))
    expect(contents).toBeDefined()
    expect(JSON.parse(contents!).dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base", "dshmarket"])
  })

  test("leaves the dependency entry alone", () => {
    let contents = ""
    removeProfileBundle({
      profileDir: "/profile",
      bundle: "dsh-lark-bot",
      read: () => manifest(["dsh-lark-bot"]),
      write: (_path, value) => void (contents = value),
    })

    expect(JSON.parse(contents).dependencies).toEqual({ dshmarket: "1.21.0" })
  })

  test("does not write when the bundle is absent", () => {
    let wrote = false
    const changed = removeProfileBundle({
      profileDir: "/profile",
      bundle: "dsh-lark-bot",
      read: () => manifest(["@deepseek-ai/dsh-base"]),
      write: () => void (wrote = true),
    })

    expect(changed).toBe(false)
    expect(wrote).toBe(false)
  })

  test("does not write when the manifest declares no bundles", () => {
    let wrote = false
    const changed = removeProfileBundle({
      profileDir: "/profile",
      bundle: "dsh-lark-bot",
      read: () => JSON.stringify({ name: "dsh-profile-web" }),
      write: () => void (wrote = true),
    })

    expect(changed).toBe(false)
    expect(wrote).toBe(false)
  })
})
