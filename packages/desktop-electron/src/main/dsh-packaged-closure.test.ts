import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { installedHarnessPackages } from "./dsh-product-patch.testing"

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

/** Bare and subpath imports of `@deepseek-ai/*` written into one package's code. */
function harnessImportsOf(packageDirectory: string) {
  const imports = new Set<string>()
  // `lib` is the convention, but not the rule — dsh-web-frontend ships `dist` —
  // and a directory this misses is a package whose imports go unread.
  for (const directory of ["lib", "dist"]) {
    const root = join(packageDirectory, directory)
    let files: string[]
    try {
      files = readdirSync(root, { recursive: true }) as string[]
    } catch {
      continue
    }
    for (const file of files) {
      // `.cjs` carries real payload here — dsh-workflow-worker-thread's worker
      // reaches four harness packages from one.
      if (!/\.(?:js|cjs|mjs)$/.test(file)) continue
      let source: string
      try {
        source = readFileSync(join(root, file), "utf8")
      } catch {
        continue
      }
      for (const [, name] of source.matchAll(/["'](@deepseek-ai\/[a-z0-9-]+)(?:\/[^"']*)?["']/g)) {
        imports.add(name)
      }
    }
  }
  return imports
}

describe("packaged DSH dependency closure", () => {
  test("every harness package the app can import survives packaging", () => {
    const closure = productionClosure()
    const installed = installedHarnessPackages()

    // Proves the sweep read a real store rather than passing on an empty one:
    // a hoisted node-linker, or DSH changing npm scope, leaves every loop below
    // running zero times and this test green having checked nothing.
    expect(installed.size).toBeGreaterThan(0)

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
})
