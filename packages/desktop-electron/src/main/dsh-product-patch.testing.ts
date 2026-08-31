import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { JSON_SCHEMA, Type, load } from "js-yaml"

// Loader entry lists — the product patch, and the agent compositions presets
// are made of — carry `!!js` rows: expressions the harness evaluates against
// its own composition context, not values a test can resolve. They load as
// their source text so a test can assert which expression a row uses without
// pretending to know what it evaluates to.
//
// `resolve` is deliberately looser than the harness's own (`dsh-app-boot`
// requires a string): a reader that accepted fewer documents than the app does
// would fail tests on rows the app loads fine.
const jsExpression = new Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (data: string) => data,
  resolve: () => true,
})

const ENTRY_LIST_SCHEMA = JSON_SCHEMA.extend([jsExpression])

export type EntryRow = {
  id?: string
  name?: string
  disabled?: boolean
  inject?: string[]
  config?: Record<string, unknown>
  // An inserted row is a row: the loader reads the same fields on it, `disabled`
  // included, so narrowing this to id/name would hide a real state from callers.
  insert?: EntryRow[]
}

export const productPatchFile = resolve(
  import.meta.dirname,
  "../../resources/dsh/home/product.cordis.patch.yml",
)

/** One entry list's rows, with `!!js` expressions kept as their source text. */
export function readEntryList(file: string): EntryRow[] {
  return load(readFileSync(file, "utf8"), { schema: ENTRY_LIST_SCHEMA }) as EntryRow[]
}

/** The product overlay's rows. */
export function readProductPatch() {
  return readEntryList(productPatchFile)
}

/**
 * Every row in an entry list, at any depth. An insert list is made of rows the
 * loader reads exactly like the rows around it, inserts included, so a check
 * that stops at the first level silently exempts anything below it.
 */
export function allRows(rows: EntryRow[]): EntryRow[] {
  return rows.flatMap((row) => [row, ...allRows(row.insert ?? [])])
}

/**
 * Every row the product overlay lands on: the dsh-base layer and the
 * dsh-web-app bundle patch stacked over it, in application order.
 *
 * These are the source rows, not the composed tree — no patch semantics are
 * applied, so one id can appear more than once and a later row states only the
 * fields it overrides. Read every row carrying an id rather than the first, or
 * a bare `- id: x / disabled: true` from the upper layer goes unseen behind the
 * lower layer's row that names the plugin.
 */
export function overlaidRows() {
  const require = createRequire(import.meta.url)
  return ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"].flatMap((bundle) =>
    allRows(readEntryList(require.resolve(`${bundle}/cordis.patch.yml`))),
  )
}

/**
 * Every package name reachable through `dependencies` from this package —
 * which is what electron-builder ships, and what a name mounted by the overlay
 * has to be inside. pnpm's store is a wider set: it also holds packages
 * installed only to satisfy a peer range, and dev dependencies, both of which
 * resolve in development and are simply absent from the packaged app.
 *
 * A lower bound, not the exact set: a package whose `exports` map omits
 * `./package.json` cannot be read this way — 21 of them today — so the walk
 * stops at its edge and never sees its own dependencies. That is the safe
 * direction, over-reporting a gap rather than missing one, and it is exact for
 * `@deepseek-ai` names because none of those 21 is one.
 */
export function productionClosure() {
  const entry = resolve(import.meta.dirname, "../../package.json")
  const visited = new Set<string>()
  const names = new Set<string>()

  const visit = (packageJsonPath: string) => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>
    }
    const require = createRequire(packageJsonPath)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      let resolved: string
      try {
        resolved = require.resolve(`${dependency}/package.json`)
      } catch {
        continue
      }
      if (visited.has(resolved)) continue
      visited.add(resolved)
      names.add(dependency)
      visit(resolved)
    }
  }

  visit(entry)
  return names
}

/**
 * Every `@deepseek-ai` package pnpm installed, and where each one lives.
 *
 * The store's shape — one directory per resolution, each holding a `node_modules`
 * with the package inside — is one fact, and the tests that read a package's own
 * files (its imports, its Typert tables) all need it. Kept here so it stays one
 * fact rather than one per test.
 */
export function installedHarnessPackages() {
  const store = resolve(import.meta.dirname, "../../../../node_modules/.pnpm")
  const found = new Map<string, string>()
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith("@deepseek-ai+")) continue
    const scope = join(store, entry, "node_modules", "@deepseek-ai")
    let members: string[]
    try {
      members = readdirSync(scope)
    } catch {
      continue
    }
    for (const member of members) found.set(`@deepseek-ai/${member}`, join(scope, member))
  }
  return found
}
