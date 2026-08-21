import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { PawWorkChannel } from "./app-identity"

// PawWork keeps its agent data in a dotdir under the user's home, the way Claude
// Code and Codex do, instead of leaving it in Electron's userData directory.
// Chromium's own state (Cache, Cookies, Local Storage, Preferences, window
// state, logs, updater cache) stays in userData — only DSH data lives here.
export const PAWWORK_HOME_DIR_NAME = ".pawwork"

// One level down rather than ~/.pawwork itself: v1 is still maintained on
// maint/v1 and owns ~/.pawwork directly, including a node_modules/ that would
// collide with the product plugin overlay v2 writes into DSH_HOME. When v1 is
// retired its files can move into ~/.pawwork/legacy/ without touching this.
const DSH_HOME_DIR_NAME: Record<PawWorkChannel, string> = { dev: "dsh-dev", prod: "dsh" }

export const DSH_MOVED_MARKER_NAME = "dsh-moved.json"

// CI smoke pins the home root explicitly because buildSmokeEnv can only set HOME,
// and os.homedir() reads USERPROFILE on Windows — a smoke run resolving through
// homedir() there would write into the real user profile.
export function resolvePawWorkHomeRoot(env: NodeJS.ProcessEnv = process.env) {
  const smokeHome = env.PAWWORK_CI_SMOKE_HOME
  return smokeHome !== undefined && smokeHome !== "" ? smokeHome : homedir()
}

export function resolveDshHome(options: { channel: PawWorkChannel; homeRoot: string }) {
  return join(options.homeRoot, PAWWORK_HOME_DIR_NAME, DSH_HOME_DIR_NAME[options.channel])
}

export type DshHomeMigrationStatus =
  | "no-legacy-home"
  | "home-already-populated"
  | "renamed"
  | "copied"
  | "failed"

export type DshHomeMigration = {
  // Where DSH should actually be started from. Everything but a failure answers
  // the new home; a failure answers the legacy one so a botched migration
  // degrades to the old location instead of an app that cannot start.
  home: string
  status: DshHomeMigrationStatus
  error?: Error
}

type MigrateDshHomeOptions = {
  home: string
  legacyHome: string
  now?: () => Date
  // Injected so the cross-device fallback can be exercised: a test cannot make
  // two temporary directories live on different filesystems.
  rename?: (from: string, to: string) => void
  onEvent?: (message: string, detail: Record<string, unknown>) => void
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isEmptyDirectory(path: string) {
  return readdirSync(path).length === 0
}

function isCrossDeviceError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV"
}

// Every path under the source, relative and with separators normalized, so the
// copy can be checked before the source is deleted. Names alone are enough: cp
// preserves contents, and a partial copy shows up as a missing entry.
function listEntries(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory()
      ? [relativePath, ...listEntries(join(root, entry.name), relativePath)]
      : [relativePath]
  })
}

function copyAcrossDevices(legacyHome: string, home: string) {
  cpSync(legacyHome, home, { recursive: true, verbatimSymlinks: true })
  const copied = new Set(listEntries(home))
  const missing = listEntries(legacyHome).filter((entry) => !copied.has(entry))
  if (missing.length) {
    throw new Error(`DSH home copy is incomplete: ${missing.slice(0, 5).join(", ")}`)
  }
  rmSync(legacyHome, { force: true, recursive: true })
}

function writeMovedMarker(legacyHome: string, home: string, movedAt: Date) {
  const marker = join(dirname(legacyHome), DSH_MOVED_MARKER_NAME)
  const document = { schema: 1, movedAt: movedAt.toISOString(), from: legacyHome, to: home }
  writeFileSync(marker, `${JSON.stringify(document, null, 2)}\n`, "utf8")
}

/**
 * Moves `<userData>/dsh` to the dotdir home the first time a build that knows
 * about the dotdir starts. Must run before the product overlay is prepared,
 * which would otherwise populate the new home and make it look already migrated.
 */
export function migrateDshHome(options: MigrateDshHomeOptions): DshHomeMigration {
  const { home, legacyHome } = options
  const rename = options.rename ?? renameSync
  const now = options.now ?? (() => new Date())
  const onEvent = options.onEvent ?? (() => {})

  if (home === legacyHome || !isDirectory(legacyHome)) {
    return { home, status: "no-legacy-home" }
  }
  // The new home wins whenever it holds anything: a newer build already wrote
  // there, and the legacy directory is a stale copy from a downgrade.
  if (isDirectory(home) && !isEmptyDirectory(home)) {
    onEvent("DSH home migration skipped, destination already populated", { home, legacyHome })
    return { home, status: "home-already-populated" }
  }

  try {
    mkdirSync(dirname(home), { recursive: true })
    // rename onto an existing directory is fine on POSIX and fails on Windows,
    // so the empty placeholder goes first either way.
    if (existsSync(home)) rmSync(home, { recursive: true })

    let status: DshHomeMigrationStatus
    try {
      rename(legacyHome, home)
      status = "renamed"
    } catch (error) {
      if (!isCrossDeviceError(error)) throw error
      copyAcrossDevices(legacyHome, home)
      status = "copied"
    }

    writeMovedMarker(legacyHome, home, now())
    onEvent("DSH home migrated", { home, legacyHome, status })
    return { home, status }
  } catch (error) {
    // A half-finished copy would read as an already-migrated home on the next
    // start, so it is removed and this run keeps using the legacy directory.
    if (existsSync(home) && isDirectory(legacyHome)) rmSync(home, { force: true, recursive: true })
    const failure = error instanceof Error ? error : new Error(String(error))
    onEvent("DSH home migration failed, staying in the legacy home", {
      home,
      legacyHome,
      error: failure.message,
    })
    return { home: legacyHome, status: "failed", error: failure }
  }
}

