import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// DSH refuses to boot when the profile declares a bundle it cannot resolve, and
// it names the offender in the message it dies with. A failed market install is
// the way users get here: the install rolls back the dependency but leaves the
// bundle declaration behind, so every later start hits the same wall and the
// only in-app action — retry — cannot change the outcome.
const UNRESOLVED_BUNDLE = /cannot resolve profile bundle "([^"]+)"/

// The other way a single plugin takes the whole runtime down: the package is
// installed, but it was built against an API this DSH no longer exports, so
// importing it throws. cordis loads every entry with `Promise.allSettled` and
// rethrows the failures, which rolls the whole configuration tree back — one
// stale plugin is enough to leave the app unopenable. The loader names the
// entry as `<id> (<name>)`; `name` is the package, and the package is what
// `dsh.profile.bundles` holds, so the parenthesized half is the one to take.
//
// Only the `import` stage: the same failure surfaces again one level up as
// `failed to apply loader entry include (cordis:include)`, and that wrapper is
// the loader's own plumbing, not anything a profile could declare. The name
// cannot hold a colon for the same reason — npm packages have none, and the
// built-in plugins that do are never bundles.
const FAILED_IMPORT_BUNDLE = /failed to import loader entry \S+ \(([^()\s:]+)\)/

export type ProfileBundleFailure = {
  bundle: string
  /** `missing`: the package is not there. `incompatible`: it is, and it will not load. */
  cause: "missing" | "incompatible"
}

/**
 * The bundle that kept DSH from booting, read from its own failure output.
 *
 * An AggregateError lists every entry that failed; the first one is as good a
 * place to start as any, and a restart re-attributes to whatever is left.
 */
export function failingProfileBundle(output: string): ProfileBundleFailure | undefined {
  const missing = UNRESOLVED_BUNDLE.exec(output)?.[1]
  if (missing !== undefined) return { bundle: missing, cause: "missing" }

  const incompatible = FAILED_IMPORT_BUNDLE.exec(output)?.[1]
  if (incompatible !== undefined) return { bundle: incompatible, cause: "incompatible" }

  return undefined
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
