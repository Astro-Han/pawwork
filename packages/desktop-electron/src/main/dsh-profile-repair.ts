import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// DSH refuses to boot when the profile declares a bundle it cannot resolve, and
// it names the offender in the message it dies with. A failed market install is
// the way users get here: the install rolls back the dependency but leaves the
// bundle declaration behind, so every later start hits the same wall and the
// only in-app action — retry — cannot change the outcome.
const UNRESOLVED_BUNDLE = /cannot resolve profile bundle "([^"]+)"/

/** The bundle DSH could not resolve, read from its own failure output. */
export function unresolvedProfileBundle(output: string) {
  return UNRESOLVED_BUNDLE.exec(output)?.[1]
}

type RemoveProfileBundleOptions = {
  profileDir: string
  bundle: string
}

/**
 * Drop one bundle from the profile manifest so DSH can boot again.
 *
 * Only `dsh.profile.bundles` is touched. A dependency entry, if one survived,
 * is left alone: it is inert as far as booting goes, and removing packages is
 * the market's job, not a recovery path's.
 *
 * @returns whether the manifest changed.
 */
export function removeProfileBundle(options: RemoveProfileBundleOptions) {
  const manifestPath = join(options.profileDir, "package.json")

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return false

  const kept = bundles.filter((entry) => entry !== options.bundle)
  if (kept.length === bundles.length) return false

  manifest.dsh!.profile!.bundles = kept
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return true
}
