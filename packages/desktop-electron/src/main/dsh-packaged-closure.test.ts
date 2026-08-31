import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { describe, expect, test } from "vitest"

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
      // A dependency this platform never installs is not a packaging gap.
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
    if (!file.endsWith(".js")) continue
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
})
