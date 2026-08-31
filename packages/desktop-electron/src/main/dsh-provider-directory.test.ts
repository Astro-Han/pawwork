import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * These assertions guard `patches/@deepseek-ai__dsh-llm-pi-ai@<version>.patch`, which restores the
 * catalog filter DSH 0.1.1-rc.1 dropped. pi-ai's `openai-codex` authenticates only through a
 * ChatGPT OAuth grant, and no DSH release yet ships a surface that can obtain one, so an unfiltered
 * directory offers an API-key form whose key can never work.
 */

function resolveInDsh(specifier: string) {
  const require = createRequire(import.meta.url)
  const dshPackage = require.resolve("@deepseek-ai/dsh/package.json")
  const webAppPackage = createRequire(dshPackage).resolve("@deepseek-ai/dsh-web-app/package.json")
  return createRequire(webAppPackage).resolve(specifier)
}

interface DirectoryEntry {
  provider: string
}

/**
 * The configurable-provider directory the installed pi-ai adapter publishes. `apply()` registers it
 * synchronously against `ctx.llm`, so a stub context with no credentials, no settings, and no
 * authorization service is enough to read it back — every other seam it reaches is optional.
 */
async function configurableProviders() {
  const adapter = await import(pathToFileURL(resolveInDsh("@deepseek-ai/dsh-llm-pi-ai")).href)
  const captured: DirectoryEntry[][] = []
  const noop = () => {}
  const ctx = {
    effect: () => noop,
    get: () => undefined,
    inject: noop,
    llm: {
      registerAdapter: () => ({ replace: noop }),
      registerConfigurableProviders: (entries: DirectoryEntry[]) => {
        captured.push(entries)
        return { replace: (next: DirectoryEntry[]) => captured.push(next) }
      },
      registerModelDiscovery: () => noop,
    },
    logger: { debug: noop, error: noop, info: noop, warn: noop },
    on: () => noop,
  }

  ;(adapter as { apply: (context: unknown, config: unknown) => void }).apply(ctx, { providers: {} })
  return (captured.at(-1) ?? []).map((entry) => entry.provider)
}

/**
 * pi-ai's own catalog, reached by path rather than by specifier: its `./providers/*` export declares
 * only an `import` condition, so `createRequire().resolve()` refuses the subpath.
 */
async function builtinProviders() {
  const adapterPackage = resolveInDsh("@deepseek-ai/dsh-llm-pi-ai/package.json")
  const catalogPath = join(dirname(adapterPackage), "..", "..", "@earendil-works", "pi-ai", "dist/providers/all.js")
  const catalog = await import(pathToFileURL(catalogPath).href)
  return (catalog as { getBuiltinProviders: () => string[] }).getBuiltinProviders()
}

describe("pi-ai configurable-provider directory", () => {
  test("hides the catalog provider PawWork cannot authenticate", async () => {
    const directory = await configurableProviders()

    expect(directory).not.toContain("openai-codex")
    expect(directory).toContain("deepseek")
    expect(directory).toContain("opencode")
  })

  test("hides only that provider", async () => {
    const [directory, builtin] = await Promise.all([configurableProviders(), builtinProviders()])

    expect(builtin.filter((provider) => !directory.includes(provider))).toEqual(["openai-codex"])
  })
})

/**
 * Every wire namespace the installed harness publishes. A Typert package states
 * its own in `lib/typert.remote-client.js`, so reading all of them describes the
 * whole reachable API — including namespaces on packages this app has never
 * heard of. 0.1.2-alpha.2 split `dsh-host-apiproxy` into three controllers
 * without adding a namespace, and a list of controller names pinned here would
 * have gone quietly stale through exactly that kind of split.
 */
function wireNamespaces() {
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
    for (const member of members) {
      let table: string
      try {
        table = readFileSync(join(scope, member, "lib", "typert.remote-client.js"), "utf8")
      } catch {
        continue
      }
      for (const [, namespace] of table.matchAll(/namespace: *['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) {
        found.set(namespace, `@deepseek-ai/${member}`)
      }
    }
  }
  return found
}

describe("DSH authorization surface", () => {
  test("still ships no wire method, so the patch is still the right call", () => {
    const namespaces = wireNamespaces()

    // Proves the scan reads real tables rather than passing on an empty sweep.
    expect(namespaces.get("credentials")).toBeDefined()
    expect(namespaces.get("llm")).toBeDefined()
    // When this fails, DSH can start a sign-in: drop the pi-ai patch, mount
    // @deepseek-ai/dsh-authorization in product.cordis.patch.yml, and delete this file.
    expect(namespaces.get("authorization")).toBeUndefined()
  })
})
