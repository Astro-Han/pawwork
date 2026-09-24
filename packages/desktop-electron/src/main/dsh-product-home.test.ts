import { afterEach, describe, expect, test } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { load } from "js-yaml"
import { allRows, overlaidRows, readProductPatch } from "./dsh-product-patch.testing"
import {
  buildDshEnvironment,
  prepareDshProductHome,
  resolveDshPackagePath,
  resolveHostModules,
  resolvePnpmPackagePath,
  resolveProductResources,
} from "./dsh-product-home"

const appPath = join(import.meta.dirname, "../..")
const hostModules = resolveHostModules({ appPath, isPackaged: false, resourcesPath: "/unused" })

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pawwork-dsh-product-"))
  temporaryDirectories.push(directory)
  return directory
}

type InstalledOpenCodeModel = { id: string; cost?: { input?: number } }

// The installed adapter's own opencode catalog, keyed by the wire protocol it
// files each model under. This is the upgrade tripwire behind the route split:
// PawWork names a protocol per route, so a pi-ai release that respells one, or
// moves a model between them, has to fail here rather than at the gateway.
function installedPiAi() {
  const require = createRequire(import.meta.url)
  const dshPackage = require.resolve("@deepseek-ai/dsh/package.json")
  const webAppPackage = createRequire(dshPackage).resolve("@deepseek-ai/dsh-web-app/package.json")
  const adapterPackage = createRequire(webAppPackage).resolve("@deepseek-ai/dsh-llm-pi-ai/package.json")
  const adapterRoot = dirname(adapterPackage)

  return { adapterRoot, piAiRoot: join(adapterRoot, "..", "..", "@earendil-works", "pi-ai") }
}

function installedOpenCodeCatalog() {
  const catalog = JSON.parse(
    readFileSync(join(installedPiAi().piAiRoot, "dist/providers/data/opencode.json"), "utf8"),
  ) as Record<string, Record<string, InstalledOpenCodeModel>>

  return new Map(Object.entries(catalog).map(([api, models]) => [api, new Map(Object.entries(models))]))
}

describe("DSH product home", () => {
  test("uses external packaged resources and source resources in development", () => {
    expect(
      resolveProductResources({
        appPath: "/Applications/PawWork.app/Contents/Resources/app",
        isPackaged: true,
        resourcesPath: "/Applications/PawWork.app/Contents/Resources",
      }),
    ).toEqual({
      dsh: join("/Applications/PawWork.app/Contents/Resources", "dsh"),
      skills: join("/Applications/PawWork.app/Contents/Resources", "skills"),
      primaryRuntime: join("/Applications/PawWork.app/Contents/Resources", "runtime", "primary-runtime"),
    })
    expect(
      resolveProductResources({
        appPath: "/repo/packages/desktop-electron",
        isPackaged: false,
        resourcesPath: "/unused",
      }),
    ).toEqual({
      dsh: join("/repo/packages/desktop-electron", "resources", "dsh"),
      skills: join("/repo/packages/desktop-electron", "..", "..", "skills"),
      primaryRuntime: join("/repo/packages/desktop-electron", "resources", "runtime", "primary-runtime"),
    })
  })

  test("runs packaged DSH from the real unpacked dependency tree", () => {
    expect(
      resolveDshPackagePath({
        isPackaged: true,
        resourcesPath: "/Applications/PawWork.app/Contents/Resources",
        resolveDevelopmentPackage: () => "/unused",
      }),
    ).toBe(
      join(
        "/Applications/PawWork.app/Contents/Resources",
        "app",
        "node_modules",
        "@deepseek-ai",
        "dsh",
        "package.json",
      ),
    )

    expect(
      resolveDshPackagePath({
        isPackaged: false,
        resourcesPath: "/unused",
        resolveDevelopmentPackage: () => "/repo/node_modules/@deepseek-ai/dsh/package.json",
      }),
    ).toBe("/repo/node_modules/@deepseek-ai/dsh/package.json")
  })

  test("runs the packaged plugin manager from the real unpacked dependency tree", () => {
    expect(
      resolvePnpmPackagePath({
        isPackaged: true,
        resourcesPath: "/Applications/PawWork.app/Contents/Resources",
        resolveDevelopmentPackage: () => "/unused",
      }),
    ).toBe(join(
      "/Applications/PawWork.app/Contents/Resources",
      "app",
      "node_modules",
      "pnpm",
      "package.json",
    ))
    expect(
      resolvePnpmPackagePath({
        isPackaged: false,
        resourcesPath: "/unused",
        resolveDevelopmentPackage: () => "/repo/node_modules/pnpm/package.json",
      }),
    ).toBe("/repo/node_modules/pnpm/package.json")
  })

  test("installs the product overlay without replacing an existing credential", () => {
    const productHome = temporaryDirectory()
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const credentials = join(productHome, ".credentials.yaml")
    mkdirSync(productHome, { recursive: true })
    writeFileSync(join(productHome, "automations.json"), '{"definitions":[]}')
    writeFileSync(credentials, 'DEEPSEEK_API_KEY: "user-key"\n')

    const prepared = prepareDshProductHome({ productHome, resources, hostModules })

    expect(readFileSync(credentials, "utf8")).toBe('DEEPSEEK_API_KEY: "user-key"\n')
    expect(readFileSync(join(productHome, "automations.json"), "utf8")).toBe('{"definitions":[]}')
    expect(readFileSync(join(productHome, "node_modules/@pawwork/dsh-bundle/cordis.patch.yml"), "utf8"))
      .toContain("id: llm-deepseek")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-product/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-product")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-automations/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-automations")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-identity/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-identity")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-web-search/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-web-search")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-updater/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-updater")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-mcp-oauth/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-mcp-oauth")
    expect(prepared.sidecarPreload).toBe(join(resources, "sidecar-preload.mjs"))
  })

  // Settings the user saves land in the profile patch, which composes above the
  // bundle layers and below any `--patch` overlay. Only a bundle leaves them
  // writable.
  test("layers the product as the last bundle of a fresh web profile", () => {
    const productHome = temporaryDirectory()
    const resources = join(import.meta.dirname, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources, hostModules })

    const profile = join(productHome, "profiles/web")
    expect(JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@pawwork/dsh-bundle",
    ])
    expect(existsSync(join(profile, "cordis.patch.yml"))).toBe(true)
    expect(existsSync(join(profile, "pnpm-workspace.yaml"))).toBe(true)
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-bundle/package.json"), "utf8")).dsh,
    ).toEqual({ bundle: { patch: "./cordis.patch.yml" } })
  })

  // Installing a bundle appends it, so the product bundle has to move back to
  // the end for its rows to keep outranking what other bundles set.
  test("keeps the product bundle last in an existing profile, keeping what it had", () => {
    const productHome = temporaryDirectory()
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const profile = join(productHome, "profiles/web")
    mkdirSync(profile, { recursive: true })
    const manifest = {
      name: "dsh-profile-web",
      private: true,
      dependencies: { "dsh-lark-bot": "0.3.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pawwork/dsh-bundle", "dsh-lark-bot"] } },
    }
    writeFileSync(join(profile, "package.json"), JSON.stringify(manifest))

    prepareDshProductHome({ productHome, resources, hostModules })
    prepareDshProductHome({ productHome, resources, hostModules })

    expect(JSON.parse(readFileSync(join(profile, "package.json"), "utf8"))).toEqual({
      ...manifest,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-lark-bot", "@pawwork/dsh-bundle"] } },
    })
  })

  // DSH imports the legacy settings file once, into the profile. The retired
  // free-tier routes must not ride along: a registered route puts its models in
  // the picker, and every send to them fails.
  test("drops the retired free-tier routes from the legacy settings before DSH imports them", () => {
    const productHome = temporaryDirectory()
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const settings = join(productHome, "settings.yaml")
    mkdirSync(productHome, { recursive: true })
    writeFileSync(settings, [
      "llm-pi-ai:",
      "  providers:",
      "    opencode: {api: openai-completions}",
      "    opencode-responses: {api: openai-responses}",
      "    opencode-go: {apiKeyEnv: OPENCODE_API_KEY}",
      "locale:",
      "  preference: en",
      "",
    ].join("\n"))

    prepareDshProductHome({ productHome, resources, hostModules })

    expect(load(readFileSync(settings, "utf8"))).toEqual({
      "llm-pi-ai": { providers: { "opencode-go": { apiKeyEnv: "OPENCODE_API_KEY" } } },
      locale: { preference: "en" },
    })
  })

  test("leaves a legacy settings file without retired routes byte for byte", () => {
    const productHome = temporaryDirectory()
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const settings = join(productHome, "settings.yaml")
    mkdirSync(productHome, { recursive: true })
    const original = "# mine\nlocale:\n  preference: en\n"
    writeFileSync(settings, original)

    prepareDshProductHome({ productHome, resources, hostModules })

    expect(readFileSync(settings, "utf8")).toBe(original)
  })

  // Under pnpm the installed `dsh` package sits in its own store directory that
  // holds only what that package declared, so deriving the tree from it would
  // hide everything this package declared for its own plugins.
  test("resolves the app's own module tree, packaged and not", () => {
    expect(resolveHostModules({ appPath: "/repo/app", isPackaged: false, resourcesPath: "/r" })).toBe(
      "/repo/app/node_modules",
    )
    expect(resolveHostModules({ appPath: "/ignored", isPackaged: true, resourcesPath: "/r" })).toBe(
      "/r/app/node_modules",
    )
  })

  // Product plugins are copied under the home, so without this link Node walks
  // up from `<home>/node_modules/@pawwork/...` and never sees the harness
  // packages the app ships — the web-search plugin's imports would fail at load.
  test("lets a product plugin resolve the host's harness packages", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources, hostModules })

    // Compared against the host's own resolution rather than a literal path:
    // both sides realpath through pnpm's store, and what has to hold is that the
    // plugin binds the very package the app loaded, not a second copy.
    const plugin = join(productHome, "node_modules/@pawwork/dsh-web-search/lib/index.js")
    expect(createRequire(plugin).resolve("@deepseek-ai/dsh-web/package.json")).toBe(
      createRequire(join(hostModules, "index.js")).resolve("@deepseek-ai/dsh-web/package.json"),
    )
  })

  test("repoints the harness link when the host tree moves", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const stale = temporaryDirectory()
    mkdirSync(join(stale, "@deepseek-ai"), { recursive: true })
    mkdirSync(join(productHome, "node_modules"), { recursive: true })
    symlinkSync(join(stale, "@deepseek-ai"), join(productHome, "node_modules/@deepseek-ai"), "junction")

    prepareDshProductHome({ productHome, resources, hostModules })

    expect(readlinkSync(join(productHome, "node_modules/@deepseek-ai"))).toBe(join(hostModules, "@deepseek-ai"))
  })

  // The ordinary shape of a moved host tree: run once from Downloads, drag the
  // app to /Applications, run again. The surviving link now points at nothing,
  // and `existsSync` follows symlinks — so a check written with it calls the
  // link absent and every launch after the move dies on `EEXIST`.
  test("repoints a harness link left dangling by the move", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")
    mkdirSync(join(productHome, "node_modules"), { recursive: true })
    symlinkSync(
      join(temporaryDirectory(), "gone", "@deepseek-ai"),
      join(productHome, "node_modules/@deepseek-ai"),
      "junction",
    )

    prepareDshProductHome({ productHome, resources, hostModules })

    expect(readlinkSync(join(productHome, "node_modules/@deepseek-ai"))).toBe(join(hostModules, "@deepseek-ai"))
  })

  // Without the scope link every bundled plugin fails to resolve its harness
  // imports, and the product patch points `web.searchProvider` at one of them —
  // so a packaging change that stops shipping `@deepseek-ai` unpacked is not a
  // degraded feature but every search answering "provider not registered". The
  // lifecycle turns this throw into its startup-failure page; returning quietly
  // would ship the mystery instead.
  test("refuses to prepare a home whose harness scope is missing", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")

    expect(() =>
      prepareDshProductHome({ productHome, resources, hostModules: join(temporaryDirectory(), "unpacked") }),
    ).toThrow(/host module scope is missing/)
  })

  // The product ships no credential, so a fresh home must not carry one: a store written here
  // would be a key the user never supplied and cannot see.
  test("leaves the credential store alone for a fresh product home", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources, hostModules })

    expect(existsSync(join(productHome, ".credentials.yaml"))).toBe(false)
  })

  test("does not publish the bundled paid DeepSeek route", () => {
    const patch = readProductPatch()

    expect(patch.find((entry) => entry.id === "llm-deepseek")?.disabled).toBe(true)
  })

  // The automation editor labels an unlisted model as one the run will not get, which is
  // only true of an adapter that resolves exactly the models it lists. pi-ai does
  // (getModel is getModels().find); llm-deepseek synthesises unlisted ids. So pi-ai has
  // to stay the only adapter the composition enables.
  test("enables pi-ai as the only model adapter", () => {
    const enabled = new Map<string, boolean>()
    for (const row of [...overlaidRows(), ...allRows(readProductPatch())]) {
      if (row.id?.startsWith("llm-")) enabled.set(row.id, row.disabled !== true)
    }
    const adapters = [...enabled].filter(([id, on]) => on && id !== "llm-retry").map(([id]) => id)
    expect(adapters).toEqual(["llm-pi-ai"])

    const { adapterRoot } = installedPiAi()
    const retryEntry = createRequire(join(adapterRoot, "package.json")).resolve("@deepseek-ai/dsh-llm-retry")
    expect(readFileSync(retryEntry, "utf8")).not.toContain("registerAdapter(")
  })

  // The mcp-client patch is only half the feature: without this row nothing
  // provides the `mcpAuth` service it asks for and OAuth servers never load.
  test("mounts the remote-MCP OAuth plugin the patched bridge consults", () => {
    expect(allRows(readProductPatch()).find((entry) => entry.id === "pawwork-mcp-oauth")).toEqual({
      id: "pawwork-mcp-oauth",
      name: "@pawwork/dsh-mcp-oauth",
    })
  })

  const resources = { skills: "/app/skills", primaryRuntime: "/app/runtime/primary-runtime" }
  const productEnvironment = {
    DSH_BUNDLED_SKILL_DIR: "/app/skills",
    PAWWORK_PRIMARY_RUNTIME: "/app/runtime/primary-runtime",
  }

  test("isolates DSH from ambient model credentials", () => {
    const environment = buildDshEnvironment(resources, {
      PATH: "/usr/bin",
      DSH_HOME: "/ambient/dsh",
      OPENCODE_API_KEY: "ambient",
      OPENCODE_GO_API_KEY: "ambient-go",
      DEEPSEEK_API_KEY: "ambient-deepseek",
      DEEPSEEK_BASE_URL: "https://example.test",
    })

    expect(environment).toEqual({ PATH: "/usr/bin", ...productEnvironment })
  })

  // Windows environment names are case-insensitive while this object is not, so a lowercase
  // export would otherwise ride along beside the name meant to replace it and leave which one
  // the sidecar sees up to the platform.
  test("drops every casing of the names the product owns", () => {
    const environment = buildDshEnvironment(resources, {
      PATH: "/usr/bin",
      opencode_api_key: "ambient",
      Deepseek_Api_Key: "ambient-deepseek",
      dsh_home: "/ambient/dsh",
      dsh_bundled_skill_dir: "/ambient/skills",
      pawwork_primary_runtime: "/ambient/runtime",
    })

    expect(environment).toEqual({ PATH: "/usr/bin", ...productEnvironment })
  })

  // credentials-local ranks the inherited environment above its own store and refuses writes it
  // would shadow, so a key left in the environment would make the one a user types on the Models
  // page unusable without saying so.
  test("names no model credential of its own", () => {
    expect(buildDshEnvironment(resources, { PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin", ...productEnvironment })
  })
  // Four parties have to agree for a paid OpenCode request to carry the id the gateway
  // routes on, and three of them are upstream: the protocol gate has to offer the switch,
  // the patch has to turn it on for this route, pi-ai has to write the id under the header
  // the preload reads, and the preload has to read that same name. Nothing else exercises
  // the chain — the smoke sends no OpenCode request — so an upstream rename would only
  // show up as every send failing in a released build.
  test("keeps the paid OpenCode route's session-id chain spelled the same way end to end", () => {
    const { adapterRoot, piAiRoot } = installedPiAi()
    const repositoryRoot = resolve(import.meta.dirname, "../../../..")
    const adapter = readFileSync(join(adapterRoot, "lib/index.js"), "utf8")
    const completions = readFileSync(join(piAiRoot, "dist/api/openai-completions.js"), "utf8")
    const preload = readFileSync(
      resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/opencode-session.mjs"),
      "utf8",
    )
    const sourceHeader = preload.match(/OPENCODE_SESSION_SOURCE_HEADER = '([^']+)'/)?.[1]

    expect(adapter).toContain('sendSessionAffinityHeaders: "offer"')
    expect(adapter).toContain('provider === "opencode-go"')
    expect(sourceHeader).toBe("x-client-request-id")
    expect(completions).toContain(`headers["${sourceHeader}"]`)
  })
})
