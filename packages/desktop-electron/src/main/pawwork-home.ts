import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PawWorkChannel } from "./app-identity"

// PawWork keeps its agent data in a dotdir under the user's home, the way Claude
// Code and Codex do, instead of leaving it in Electron's userData directory.
// Chromium's own state (Cache, Cookies, Local Storage, Preferences, window
// state, logs, updater cache) stays in userData — only DSH data lives here.
const PAWWORK_HOME_DIR_NAME = ".pawwork"

// One level down rather than ~/.pawwork itself: v1 is still maintained on
// maint/v1 and owns ~/.pawwork directly, including a node_modules/ that would
// collide with the product plugin overlay v2 writes into DSH_HOME. When v1 is
// retired its files can move into ~/.pawwork/legacy/ without touching this.
const DSH_HOME_DIR_NAME: Record<PawWorkChannel, string> = { dev: "dsh-dev", prod: "dsh" }

const DSH_MOVED_MARKER_NAME = "dsh-moved.json"

export function resolveDshHome(options: { channel: PawWorkChannel; homeRoot: string }) {
  return join(options.homeRoot, PAWWORK_HOME_DIR_NAME, DSH_HOME_DIR_NAME[options.channel])
}

type MigrateDshHomeOptions = {
  home: string
  legacyHome: string
  now?: () => Date
  // Injected so the cross-device path can be exercised: a test cannot make two
  // temporary directories live on different filesystems.
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

function describe(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

// Where a cross-device copy is assembled before it becomes the home. A sibling
// of the home so the final rename stays on one filesystem.
function stagingHome(home: string) {
  return `${home}.migrating`
}

// Every path under the root, relative and separator-normalized, so a copy can be
// checked against its source. Names alone are enough: cp preserves contents, and
// an interrupted copy shows up as a missing entry.
function listEntries(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory()
      ? [relativePath, ...listEntries(join(root, entry.name), relativePath)]
      : [relativePath]
  })
}

/**
 * Moves the legacy home onto the new path and returns how it got there. This is
 * the commit point: it either throws with the legacy home still authoritative,
 * or returns with the new home holding the data.
 */
function commitDshHome(legacyHome: string, home: string, rename: (from: string, to: string) => void) {
  try {
    rename(legacyHome, home)
    return "renamed" as const
  } catch (error) {
    if (!isCrossDeviceError(error)) throw error
    // A cross-device move has no rename to lean on, so the atomicity is built
    // by hand: copy into a sibling staging directory, verify it, and only then
    // rename it into place. A copy interrupted by a crash leaves the staging
    // directory behind rather than a half-written home that the next start
    // would read as already migrated.
    const staging = stagingHome(home)
    rmSync(staging, { force: true, recursive: true })
    cpSync(legacyHome, staging, { recursive: true, verbatimSymlinks: true })
    // cpSync throws rather than skipping entries, so this is a backstop, not
    // the primary guard: nothing gets deleted until the copy has been read back.
    const copied = new Set(listEntries(staging))
    const missing = listEntries(legacyHome).filter((entry) => !copied.has(entry))
    if (missing.length) throw new Error(`DSH home copy is incomplete: ${missing.slice(0, 5).join(", ")}`)
    renameSync(staging, home)
    return "copied" as const
  }
}

/**
 * Moves `<userData>/dsh` to the dotdir home the first time a build that knows
 * about the dotdir starts, and answers where DSH should actually be started
 * from: the new home, or the legacy one when the move failed, so a botched
 * migration degrades to the old location instead of an app that cannot start.
 *
 * Must run before the product overlay is prepared, which would otherwise
 * populate the new home and make it look already migrated.
 */
export function migrateDshHome(options: MigrateDshHomeOptions): string {
  const { home, legacyHome } = options
  const rename = options.rename ?? renameSync
  const now = options.now ?? (() => new Date())
  const onEvent = options.onEvent ?? (() => {})

  let status: "renamed" | "copied"
  try {
    if (!isDirectory(legacyHome)) return home
    // The new home wins whenever it holds anything: a newer build already wrote
    // there, and the legacy directory is a stale copy from a downgrade.
    if (isDirectory(home) && !isEmptyDirectory(home)) {
      onEvent("DSH home migration skipped, destination already populated", { home, legacyHome })
      return home
    }

    // ~/Library is 0700 and used to protect the sessions inside it; the home
    // directory is not, so the dotdir has to ask. An existing ~/.pawwork — v1
    // owns one — keeps whatever mode it already has.
    mkdirSync(dirname(home), { mode: 0o700, recursive: true })
    // rename onto an existing directory is fine on POSIX and fails on Windows,
    // so the empty placeholder goes first either way.
    if (existsSync(home)) rmSync(home, { recursive: true })

    status = commitDshHome(legacyHome, home, rename)
  } catch (error) {
    // Only reachable before the commit, so the legacy home is still intact and
    // anything at the new path is a leftover the next start would misread as a
    // migrated home.
    rmSync(home, { force: true, recursive: true })
    rmSync(stagingHome(home), { force: true, recursive: true })
    onEvent("DSH home migration failed, staying in the legacy home", {
      home,
      legacyHome,
      error: describe(error).message,
    })
    return legacyHome
  }

  // Past the commit the new home is authoritative, so the rest is best-effort:
  // failing to tidy up must not undo a move that already succeeded.
  discardLegacyHome(legacyHome, onEvent)
  writeMovedMarker(legacyHome, home, now, onEvent)
  onEvent("DSH home migrated", { home, legacyHome, status })
  return home
}

// Left over only after a cross-device copy. Keeping it costs a stale directory
// the next start walks past; deleting the migrated home to "undo" would cost the
// data, so a lock or a permission problem here just gets logged.
function discardLegacyHome(legacyHome: string, onEvent: NonNullable<MigrateDshHomeOptions["onEvent"]>) {
  try {
    // force swallows ENOENT, so the rename path — where there is nothing left
    // to discard — passes straight through.
    rmSync(legacyHome, { force: true, maxRetries: 3, recursive: true })
  } catch (error) {
    onEvent("DSH legacy home left behind", { legacyHome, error: describe(error).message })
  }
}

// A signpost for whoever goes looking in the old location. Nothing reads it, so
// a write failure is worth a log line and nothing more.
function writeMovedMarker(
  legacyHome: string,
  home: string,
  now: () => Date,
  onEvent: NonNullable<MigrateDshHomeOptions["onEvent"]>,
) {
  const marker = join(dirname(legacyHome), DSH_MOVED_MARKER_NAME)
  try {
    const document = { schema: 1, movedAt: now().toISOString(), from: legacyHome, to: home }
    writeFileSync(marker, `${JSON.stringify(document, null, 2)}\n`, "utf8")
  } catch (error) {
    onEvent("DSH moved marker not written", { marker, error: describe(error).message })
  }
}
