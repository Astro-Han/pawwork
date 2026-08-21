import { afterEach, describe, expect, test } from "vitest"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

type Homes = { root: string; legacyHome: string; home: string }

// A DSH home the way the app leaves it: sessions, settings, the private
// credential file, the two directories PawWork owns itself, and one of the
// symlinks the product overlay points at the install directory.
function seedHomes(): Homes {
  const root = temporaryDirectory()
  const legacyHome = join(root, "userData", "dsh")
  mkdirSync(join(legacyHome, "sessions"), { recursive: true })
  mkdirSync(join(legacyHome, "import-v1"), { recursive: true })
  writeFileSync(join(legacyHome, "sessions", "session-1.json"), '{"id":"session-1"}')
  writeFileSync(join(legacyHome, "settings.yaml"), "theme: dark\n")
  writeFileSync(join(legacyHome, ".credentials.yaml"), 'OPENCODE_API_KEY: "public"\n', { mode: 0o600 })
  writeFileSync(join(legacyHome, "automations.json"), '{"schema":1}')
  writeFileSync(join(legacyHome, "import-v1", "ledger.json"), '{"schema":1}')
  symlinkSync("/Applications/PawWork.app/Contents/Resources/dsh", join(legacyHome, "installed"))
  return { root, legacyHome, home: join(root, ".pawwork", "dsh") }
}

function markerPath({ legacyHome }: Homes) {
  return join(dirname(legacyHome), DSH_MOVED_MARKER_NAME)
}

function readMovedMarker(homes: Homes) {
  return JSON.parse(readFileSync(markerPath(homes), "utf8")) as Record<string, unknown>
}

// The only failure renameSync can report that the migration recovers from.
function crossDeviceRename() {
  return () => {
    const error = new Error("cross-device link not permitted") as NodeJS.ErrnoException
    error.code = "EXDEV"
    throw error
  }
}

function collectEvents() {
  const events: Record<string, unknown>[] = []
  return {
    events,
    onEvent: (message: string, detail: Record<string, unknown>) => events.push({ message, ...detail }),
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
    expect(resolvePawWorkHomeRoot({})).toBe(homedir())
  })

  test("renames the legacy home and leaves a marker behind", () => {
    const homes = seedHomes()
    const { events, onEvent } = collectEvents()

    const migration = migrateDshHome({
      ...homes,
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      onEvent,
    })

    expect(migration).toEqual({ home: homes.home, status: "renamed" })
    expect(existsSync(homes.legacyHome)).toBe(false)
    expect(readFileSync(join(homes.home, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(readFileSync(join(homes.home, "sessions", "session-1.json"), "utf8")).toBe('{"id":"session-1"}')
    expect(readFileSync(join(homes.home, "import-v1", "ledger.json"), "utf8")).toBe('{"schema":1}')
    expect(readMovedMarker(homes)).toMatchObject({
      movedAt: "2026-08-21T00:00:00.000Z",
      from: homes.legacyHome,
      to: homes.home,
    })
    expect(events).toEqual([
      { message: "DSH home migrated", home: homes.home, legacyHome: homes.legacyHome, status: "renamed" },
    ])
  })

  test("creates the dotdir private to the user", () => {
    // ~/Library is 0700 and used to protect the sessions inside it. The home
    // directory is not, so the dotdir has to ask for it.
    const homes = seedHomes()

    migrateDshHome(homes)

    expect(statSync(dirname(homes.home)).mode & 0o777).toBe(0o700)
  })

  test("copies through a staging directory when the homes are on different filesystems", () => {
    const homes = seedHomes()

    const migration = migrateDshHome({ ...homes, rename: crossDeviceRename() })

    expect(migration).toEqual({ home: homes.home, status: "copied" })
    expect(existsSync(homes.legacyHome)).toBe(false)
    expect(existsSync(`${homes.home}.migrating`)).toBe(false)
    expect(readdirSync(homes.home).sort()).toEqual([
      ".credentials.yaml",
      "automations.json",
      "import-v1",
      "installed",
      "sessions",
      "settings.yaml",
    ])
    expect(readFileSync(join(homes.home, "import-v1", "ledger.json"), "utf8")).toBe('{"schema":1}')
    // The credential file is the one thing in here that must not widen.
    expect(statSync(join(homes.home, ".credentials.yaml")).mode & 0o777).toBe(0o600)
    // Overlay symlinks point at the install directory; following them would
    // copy the installed product into the user's home.
    expect(lstatSync(join(homes.home, "installed")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(homes.home, "installed"))).toBe(
      "/Applications/PawWork.app/Contents/Resources/dsh",
    )
    expect(existsSync(markerPath(homes))).toBe(true)
  })

  test("keeps the migrated home when the legacy home cannot be deleted afterwards", () => {
    if (process.getuid?.() === 0) return // root deletes regardless of the mode below
    const homes = seedHomes()
    const { events, onEvent } = collectEvents()
    // A read-only parent is the portable stand-in for the real cause: a file in
    // the legacy home held open on Windows.
    chmodSync(dirname(homes.legacyHome), 0o555)

    const migration = migrateDshHome({ ...homes, onEvent, rename: crossDeviceRename() })
    chmodSync(dirname(homes.legacyHome), 0o755)

    // The copy was verified before the delete was attempted, so the move stands
    // and the undeleted legacy home is just litter.
    expect(migration).toEqual({ home: homes.home, status: "copied" })
    expect(readFileSync(join(homes.home, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(events.map((event) => event.message)).toEqual([
      "DSH legacy home left behind",
      "DSH moved marker not written",
      "DSH home migrated",
    ])
  })

  test("keeps the migrated home when the marker cannot be written", () => {
    const homes = seedHomes()
    const { events, onEvent } = collectEvents()

    const migration = migrateDshHome({
      ...homes,
      onEvent,
      now: () => {
        throw new Error("no space left on device")
      },
    })

    // The rename already committed: answering the legacy home here would start
    // DSH on a path that no longer exists.
    expect(migration).toEqual({ home: homes.home, status: "renamed" })
    expect(readFileSync(join(homes.home, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(existsSync(markerPath(homes))).toBe(false)
    expect(events.map((event) => event.message)).toEqual([
      "DSH moved marker not written",
      "DSH home migrated",
    ])
  })

  test("does nothing on the second start", () => {
    const homes = seedHomes()

    migrateDshHome(homes)
    writeFileSync(join(homes.home, "settings.yaml"), "theme: light\n")
    const second = migrateDshHome(homes)

    expect(second).toEqual({ home: homes.home, status: "no-legacy-home" })
    expect(readFileSync(join(homes.home, "settings.yaml"), "utf8")).toBe("theme: light\n")
  })

  test("keeps a populated home and leaves the legacy directory untouched", () => {
    const homes = seedHomes()
    mkdirSync(homes.home, { recursive: true })
    writeFileSync(join(homes.home, "settings.yaml"), "theme: light\n")

    const migration = migrateDshHome(homes)

    expect(migration).toEqual({ home: homes.home, status: "home-already-populated" })
    expect(readFileSync(join(homes.home, "settings.yaml"), "utf8")).toBe("theme: light\n")
    expect(readFileSync(join(homes.legacyHome, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(existsSync(markerPath(homes))).toBe(false)
  })

  test("migrates into an empty home directory", () => {
    const homes = seedHomes()
    mkdirSync(homes.home, { recursive: true })

    expect(migrateDshHome(homes)).toEqual({ home: homes.home, status: "renamed" })
    expect(readFileSync(join(homes.home, "settings.yaml"), "utf8")).toBe("theme: dark\n")
  })

  test("falls back to the legacy home and clears the leftovers when the move fails", () => {
    const homes = seedHomes()
    const { events, onEvent } = collectEvents()

    const migration = migrateDshHome({
      ...homes,
      onEvent,
      rename: (_from, to) => {
        mkdirSync(to, { recursive: true })
        writeFileSync(join(to, "settings.yaml"), "theme: dark\n")
        throw new Error("disk is full")
      },
    })

    expect(migration.status).toBe("failed")
    expect(migration.home).toBe(homes.legacyHome)
    expect(migration.error?.message).toBe("disk is full")
    // Nothing committed, so the leftovers go: the next start has to migrate
    // again rather than read them as a home a newer build had written.
    expect(existsSync(homes.home)).toBe(false)
    expect(existsSync(`${homes.home}.migrating`)).toBe(false)
    expect(readFileSync(join(homes.legacyHome, "settings.yaml"), "utf8")).toBe("theme: dark\n")
    expect(existsSync(markerPath(homes))).toBe(false)
    expect(events.map((event) => event.message)).toEqual([
      "DSH home migration failed, staying in the legacy home",
    ])
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
