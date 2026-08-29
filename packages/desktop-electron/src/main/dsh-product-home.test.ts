import { afterEach, describe, expect, test } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DOCUMENT_VERSION, parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local"
import { readProductPatch } from "./dsh-product-patch.testing"
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

function installedOpenCodeFreeModels() {
  const require = createRequire(import.meta.url)
  const dshPackage = require.resolve("@deepseek-ai/dsh/package.json")
  const webAppPackage = createRequire(dshPackage).resolve("@deepseek-ai/dsh-web-app/package.json")
  const adapterPackage = createRequire(webAppPackage).resolve("@deepseek-ai/dsh-llm-pi-ai/package.json")
  const piAiRoot = join(dirname(adapterPackage), "..", "..", "@earendil-works", "pi-ai")
  const catalog = JSON.parse(readFileSync(join(piAiRoot, "dist/providers/data/opencode.json"), "utf8"))

  return Object.values(catalog)
    .flatMap((models) => Object.values(models as Record<string, { id: string; cost?: { input?: number } }>))
    .filter((model) => model.cost?.input === 0)
    .map((model) => model.id)
    .sort()
}

describe("DSH product home", () => {
  test("uses external packaged resources and source resources in development", () => {
    expect(
      resolveProductResources({
        appPath: "/Applications/PawWork.app/Contents/Resources/app.asar",
        isPackaged: true,
        resourcesPath: "/Applications/PawWork.app/Contents/Resources",
      }),
    ).toEqual({
      dsh: join("/Applications/PawWork.app/Contents/Resources", "dsh"),
      skills: join("/Applications/PawWork.app/Contents/Resources", "skills"),
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
        "app.asar.unpacked",
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
      "app.asar.unpacked",
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
    expect(readFileSync(prepared.patch, "utf8")).toContain("id: agent-default-model")
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
    expect(prepared.sidecarPreload).toBe(join(resources, "sidecar-preload.mjs"))
  })

  // Under pnpm the installed `dsh` package sits in its own store directory that
  // holds only what that package declared, so deriving the tree from it would
  // hide everything this package declared for its own plugins.
  test("resolves the app's own module tree, packaged and not", () => {
    expect(resolveHostModules({ appPath: "/repo/app", isPackaged: false, resourcesPath: "/r" })).toBe(
      "/repo/app/node_modules",
    )
    expect(resolveHostModules({ appPath: "/ignored", isPackaged: true, resourcesPath: "/r" })).toBe(
      "/r/app.asar.unpacked/node_modules",
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

  test("creates the public free-model credential for a fresh product home", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources, hostModules })

    expect(readFileSync(join(productHome, ".credentials.yaml"), "utf8")).toBe(
      'version: 1\nrefs:\n  OPENCODE_API_KEY: "public"\n',
    )
    // The file sits next to every other user in a shared home, and the next key
    // written into it is the user's own. Windows ignores the mode entirely.
    if (process.platform !== "win32") {
      expect(statSync(join(productHome, ".credentials.yaml")).mode & 0o777).toBe(0o600)
    }
  })

  // The seed is a literal, so byte-equality against another literal can only
  // restate it. What has to hold is that the *installed* DSH accepts it: the
  // format is versioned now, and a DSH that moves to version 2 would otherwise
  // fail nowhere until a user's app quietly refuses to open.
  test("seeds a credential document the installed DSH accepts", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources, hostModules })
    const file = join(productHome, ".credentials.yaml")
    const seeded = readFileSync(file, "utf8")

    expect(DOCUMENT_VERSION).toBe(1)
    const parsed = parseCredentialsDocument(seeded, file)
    expect([...parsed.refs]).toEqual([["OPENCODE_API_KEY", "public"]])
  })

  test("publishes the installed zero-cost OpenCode catalog as OpenCode Free", () => {
    const patch = readProductPatch()
    const modelDefaults = patch.find((entry) => entry.id === "agent-default-model")?.config as {
      provider: string
      model: string
    }
    const providerConfig = patch.find((entry) => entry.id === "llm-pi-ai")?.config as {
      providers: { opencode: { displayName?: string; models?: Array<{ id: string }> } }
    }
    const freeModels = installedOpenCodeFreeModels()

    expect(providerConfig.providers.opencode.displayName).toBe("OpenCode Free")
    expect(providerConfig.providers.opencode.models?.map((model) => model.id).sort()).toEqual(freeModels)
    expect(modelDefaults.provider).toBe("opencode")
    expect(freeModels).toContain(modelDefaults.model)
  })

  test("does not publish the bundled paid DeepSeek route", () => {
    const patch = readProductPatch()

    expect(patch.find((entry) => entry.id === "llm-deepseek")?.disabled).toBe(true)
  })

  test("makes the community market wait for PawWork-owned Desktop services", () => {
    const patch = readProductPatch()

    expect(patch.find((entry) => entry.id === "dsh-market")).toEqual({
      id: "dsh-market",
      inject: ["desktopProfiles", "desktopPnpm"],
    })
  })

  test("isolates DSH from ambient model credentials", () => {
    const environment = buildDshEnvironment("/app/skills", {
      PATH: "/usr/bin",
      DSH_HOME: "/ambient/dsh",
      OPENCODE_API_KEY: "ambient",
      OPENCODE_GO_API_KEY: "ambient-go",
      DEEPSEEK_API_KEY: "ambient-deepseek",
      DEEPSEEK_BASE_URL: "https://example.test",
    })

    expect(environment).toEqual({
      PATH: "/usr/bin",
      DSH_BUNDLED_SKILL_DIR: "/app/skills",
    })
  })
})
