import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  DSH_MOVED_MARKER_NAME,
  migrateDshHome,
  resolveDshHome,
  resolvePawWorkHomeRoot,
} from "./pawwork-home"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pawwork-home-"))
  temporaryDirectories.push(directory)
  return directory
}

// A DSH home the way the app leaves it: sessions, settings, the private
// credential file, and the two directories PawWork owns itself.
function seedLegacyHome(legacyHome: string) {
  mkdirSync(join(legacyHome, "sessions"), { recursive: true })
  mkdirSync(join(legacyHome, "import-v1"), { recursive: true })
  writeFileSync(join(legacyHome, "sessions", "session-1.json"), '{"id":"session-1"}')
  writeFileSync(join(legacyHome, "settings.yaml"), "theme: dark\n")
  writeFileSync(join(legacyHome, ".credentials.yaml"), 'OPENCODE_API_KEY: "public"\n', { mode: 0o600 })
  writeFileSync(join(legacyHome, "automations.json"), '{"schema":1}')
  writeFileSync(join(legacyHome, "import-v1", "ledger.json"), '{"schema":1}')
}

function readMovedMarker(legacyHome: string) {
  return JSON.parse(readFileSync(join(legacyHome, "..", DSH_MOVED_MARKER_NAME), "utf8")) as {
    schema: number
    movedAt: string
    from: string
    to: string
  }
}

function crossDeviceRename() {
  return () => {
    const error = new Error("cross-device link not permitted") as NodeJS.ErrnoException
    error.code = "EXDEV"
    throw error
  }
}

describe("PawWork home", () => {
  test("resolves the DSH home per channel under the home dotdir", () => {
    expect(resolveDshHome({ channel: "prod", homeRoot: "/Users/pawwork" })).toBe(
      join("/Users/pawwork", ".pawwork", "dsh"),
    )
    expect(resolveDshHome({ channel: "dev", homeRoot: "/Users/pawwork" })).toBe(
      join("/Users/pawwork", ".pawwork", "dsh-dev"),
    )
  })

  test("prefers the CI smoke home over the real user home", () => {
    // Windows resolves os.homedir() from USERPROFILE, which buildSmokeEnv does
    // not set, so a smoke run that fell through to homedir() would write into
    // the real user profile.
    expect(resolvePawWorkHomeRoot({ PAWWORK_CI_SMOKE_HOME: "/tmp/smoke" })).toBe("/tmp/smoke")
    expect(resolvePawWorkHomeRoot({ PAWWORK_CI_SMOKE_HOME: "" })).toBe(homedir())
    expect(resolvePawWorkHomeRoot({})).toBe(homedir())
  })

  test("renames the legacy home and leaves a marker behind", () => {
    const root = temporaryDirectory()
    const legacyHome = join(root, "userData", "dsh")
    const home = join(root, ".pawwork", "dsh")
    seedLegacyHome(legacyHome)

    const events: string[] = []
    const migration = migrateDshHome({
      home,
      legacyHome,
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      onEvent: (message) => events.push(message),
    })

    expect(migration).toEqual({ home, status: "renamed" })
    expect(existsSync(legacyHome)).toBe(false)
    expect(readFileSync(join(home, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(readFileSync(join(home, "sessions", "session-1.json"), "utf8")).toBe('{"id":"session-1"}')
    expect(readFileSync(join(home, "import-v1", "ledger.json"), "utf8")).toBe('{"schema":1}')
    expect(readMovedMarker(legacyHome)).toEqual({
      schema: 1,
      movedAt: "2026-08-21T00:00:00.000Z",
      from: legacyHome,
      to: home,
    })
    expect(events).toEqual(["DSH home migrated"])
  })

  test("copies and verifies before deleting when the homes are on different filesystems", () => {
    const root = temporaryDirectory()
    const legacyHome = join(root, "userData", "dsh")
    const home = join(root, ".pawwork", "dsh")
    seedLegacyHome(legacyHome)

    const migration = migrateDshHome({ home, legacyHome, rename: crossDeviceRename() })

    expect(migration).toEqual({ home, status: "copied" })
    expect(existsSync(legacyHome)).toBe(false)
    expect(readdirSync(home).sort()).toEqual([
      ".credentials.yaml",
      "automations.json",
      "import-v1",
      "sessions",
      "settings.yaml",
    ])
    expect(readFileSync(join(home, "import-v1", "ledger.json"), "utf8")).toBe('{"schema":1}')
    expect(existsSync(join(root, "userData", DSH_MOVED_MARKER_NAME))).toBe(true)
  })

  test("does nothing on the second start", () => {
    const root = temporaryDirectory()
    const legacyHome = join(root, "userData", "dsh")
    const home = join(root, ".pawwork", "dsh")
    seedLegacyHome(legacyHome)

    migrateDshHome({ home, legacyHome })
    writeFileSync(join(home, "settings.yaml"), "theme: light\n")
    const second = migrateDshHome({ home, legacyHome })

    expect(second).toEqual({ home, status: "no-legacy-home" })
    expect(readFileSync(join(home, "settings.yaml"), "utf8")).toBe("theme: light\n")
  })

  test("keeps a populated home and leaves the legacy directory untouched", () => {
    const root = temporaryDirectory()
    const legacyHome = join(root, "userData", "dsh")
    const home = join(root, ".pawwork", "dsh")
    seedLegacyHome(legacyHome)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "settings.yaml"), "theme: light\n")

    const migration = migrateDshHome({ home, legacyHome })

    expect(migration).toEqual({ home, status: "home-already-populated" })
    expect(readFileSync(join(home, "settings.yaml"), "utf8")).toBe("theme: light\n")
    expect(readFileSync(join(legacyHome, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(existsSync(join(root, "userData", DSH_MOVED_MARKER_NAME))).toBe(false)
  })

  test("migrates into an empty home directory", () => {
    const root = temporaryDirectory()
    const legacyHome = join(root, "userData", "dsh")
    const home = join(root, ".pawwork", "dsh")
    seedLegacyHome(legacyHome)
    mkdirSync(home, { recursive: true })

    expect(migrateDshHome({ home, legacyHome })).toEqual({ home, status: "renamed" })
    expect(readFileSync(join(home, "settings.yaml"), "utf8")).toBe("theme: dark\n")
  })

  test("falls back to the legacy home and clears a half-written home when the move fails", () => {
    const root = temporaryDirectory()
    const legacyHome = join(root, "userData", "dsh")
    const home = join(root, ".pawwork", "dsh")
    seedLegacyHome(legacyHome)

    const events: string[] = []
    const migration = migrateDshHome({
      home,
      legacyHome,
      onEvent: (message) => events.push(message),
      rename: (_from, to) => {
        mkdirSync(to, { recursive: true })
        writeFileSync(join(to, "settings.yaml"), "theme: dark\n")
        throw new Error("disk is full")
      },
    })

    expect(migration.status).toBe("failed")
    expect(migration.home).toBe(legacyHome)
    expect(migration.error?.message).toBe("disk is full")
    // The partial copy is gone, so the next start migrates again instead of
    // reading it as a home a newer build had already written.
    expect(existsSync(home)).toBe(false)
    expect(readFileSync(join(legacyHome, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(existsSync(join(root, "userData", DSH_MOVED_MARKER_NAME))).toBe(false)
    expect(events).toEqual(["DSH home migration failed, staying in the legacy home"])
  })

  test("does nothing when there is no legacy home", () => {
    const root = temporaryDirectory()
    const home = join(root, ".pawwork", "dsh")

    expect(migrateDshHome({ home, legacyHome: join(root, "userData", "dsh") })).toEqual({
      home,
      status: "no-legacy-home",
    })
    expect(existsSync(home)).toBe(false)
  })
})
