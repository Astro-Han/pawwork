import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { type EntryRow, readEntryList } from "./dsh-product-patch.testing"

/**
 * electron-builder ships the production dependency closure — what `dependencies`
 * reach from this package, transitively — and prunes everything else. pnpm's
 * store is not that closure: it also holds packages installed only to satisfy a
 * peer range, which resolve fine in development and are simply absent from the
 * packaged app.
 *
 * DSH declares most of its own internals as peers, so a release that moves one
 * package's dependency to a peer takes it out of the closure without changing a
 * single line here. The packaged smoke does catch it — as a boot failure on
 * three CI runners, minutes into a build. This catches it in milliseconds.
 */

const packageRoot = resolve(import.meta.dirname, "../..")
const workspaceRoot = resolve(packageRoot, "../..")
const require = createRequire(import.meta.url)

/** Every package name reachable through `dependencies` from this package. */
function productionClosure() {
  const entry = join(packageRoot, "package.json")
  const visited = new Set<string>()
  const names = new Set<string>()

  const visit = (packageJsonPath: string) => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> }
    const require = createRequire(packageJsonPath)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      let resolved: string
      // A package whose `exports` map omits `./package.json` cannot be read
      // this way — 21 of them today — so the walk stops at its edge and never
      // sees its own dependencies. That makes this closure a lower bound on
      // what electron-builder ships, which is the safe direction: it can
      // over-report a gap, never miss one. It holds as a bound only because no
      // `@deepseek-ai` package is among those 21, so no truncated subtree can
      // hide a harness package that packaging would in fact keep.
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

/** Every `@deepseek-ai` package in the pnpm store, and where each one lives. */
function installedHarnessPackages() {
  const store = join(workspaceRoot, "node_modules", ".pnpm")
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

/** Bare and subpath imports of `@deepseek-ai/*` written into one package's `lib`. */
function harnessImportsOf(packageDirectory: string) {
  const lib = join(packageDirectory, "lib")
  const imports = new Set<string>()
  let files: string[]
  try {
    files = readdirSync(lib, { recursive: true }) as string[]
  } catch {
    return imports
  }
  for (const file of files) {
    // `.cjs` carries real payload here — dsh-workflow-worker-thread's worker
    // reaches four harness packages from one.
    if (!/\.(?:js|cjs|mjs)$/.test(file)) continue
    let source: string
    try {
      source = readFileSync(join(lib, file), "utf8")
    } catch {
      continue
    }
    for (const [, name] of source.matchAll(/["'](@deepseek-ai\/[a-z0-9-]+)(?:\/[^"']*)?["']/g)) {
      imports.add(name)
    }
  }
  return imports
}

/**
 * The two compositions the app boots: dsh-base's overlay and the browser-surface
 * bundle's. Their rows name plugins as strings the cordis loader imports, so a
 * package can be mounted at startup without one line of JS naming it — 103 of
 * them are today. Import scanning alone cannot see any of those.
 */
function compositionMountedNames() {
  const webAppPackage = createRequire(require.resolve("@deepseek-ai/dsh/package.json")).resolve(
    "@deepseek-ai/dsh-web-app/package.json",
  )
  const compositions = [
    require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml"),
    join(dirname(webAppPackage), "cordis.patch.yml"),
  ]

  const mounted = new Set<string>()
  const walk = (rows: EntryRow[]) => {
    for (const row of rows) {
      // A row's name may carry a subpath (`dsh-tool-subagent/model-selection-settings`);
      // packaging keeps or drops the whole package, so scope+name is the unit.
      const [scope, member] = (row.name ?? "").split("/")
      if (scope === "@deepseek-ai" && member !== undefined) mounted.add(`${scope}/${member}`)
      walk(row.insert ?? [])
    }
  }
  for (const composition of compositions) walk(readEntryList(composition))
  return mounted
}

describe("packaged DSH dependency closure", () => {
  test("every harness package the app can import survives packaging", () => {
    const closure = productionClosure()
    const installed = installedHarnessPackages()

    // Only packages the app could actually reach matter: something inside the
    // closure has to import it. A store entry nothing imports is dead weight
    // pnpm keeps, and pruning it is what packaging is for.
    const reachableButPruned = new Set<string>()
    for (const [name, directory] of installed) {
      if (!closure.has(name)) continue
      for (const imported of harnessImportsOf(directory)) {
        if (imported !== name && installed.has(imported) && !closure.has(imported)) {
          reachableButPruned.add(`${imported} (imported by ${name})`)
        }
      }
    }

    expect([...reachableButPruned].sort()).toEqual([])
  })

  test("every harness package the compositions mount survives packaging", () => {
    const closure = productionClosure()

    const mountedButPruned = [...compositionMountedNames()].filter((name) => !closure.has(name))

    expect(mountedButPruned.sort()).toEqual([])
  })
})
