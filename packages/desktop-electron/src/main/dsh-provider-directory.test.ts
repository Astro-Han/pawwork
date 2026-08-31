import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
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

/** Every wire controller behind the API gateway; 0.1.2-alpha.2 split `dsh-host-apiproxy` into these. */
const API_CONTROLLERS = [
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-settings-controller",
  "@deepseek-ai/dsh-api-workspace-controller",
]

describe("DSH authorization surface", () => {
  test("still ships no wire method, so the patch is still the right call", () => {
    const routes = API_CONTROLLERS.map((specifier) => readFileSync(resolveInDsh(specifier), "utf8")).join("\n")

    // Proves the scan reads the tables it thinks it does rather than passing on moved files.
    expect(routes).toContain('"credentials.describe"')
    // When this fails, DSH can start a sign-in: drop the pi-ai patch, mount
    // @deepseek-ai/dsh-authorization in product.cordis.patch.yml, and delete this file.
    expect(routes).not.toContain('"authorization.')
  })
})
