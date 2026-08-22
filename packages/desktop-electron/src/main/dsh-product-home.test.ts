import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { load } from "js-yaml"
import { DOCUMENT_VERSION, parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local"
import {
  buildDshEnvironment,
  prepareDshProductHome,
  resolveDshPackagePath,
  resolveProductResources,
} from "./dsh-product-home"

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

  test("installs the product overlay without replacing an existing credential", () => {
    const productHome = temporaryDirectory()
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const credentials = join(productHome, ".credentials.yaml")
    mkdirSync(productHome, { recursive: true })
    writeFileSync(join(productHome, "automations.json"), '{"definitions":[]}')
    writeFileSync(credentials, 'DEEPSEEK_API_KEY: "user-key"\n')

    const prepared = prepareDshProductHome({ productHome, resources })

    expect(readFileSync(credentials, "utf8")).toBe('DEEPSEEK_API_KEY: "user-key"\n')
    expect(readFileSync(join(productHome, "automations.json"), "utf8")).toBe('{"definitions":[]}')
    expect(readFileSync(prepared.patch, "utf8")).toContain("id: agent-default-model")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-product/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-product")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-automations/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-automations")
    expect(prepared.sidecarPreload).toBe(join(resources, "sidecar-preload.mjs"))
  })

  test("creates the public free-model credential for a fresh product home", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dirname, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources })

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

    prepareDshProductHome({ productHome, resources })
    const file = join(productHome, ".credentials.yaml")
    const seeded = readFileSync(file, "utf8")

    expect(DOCUMENT_VERSION).toBe(1)
    const parsed = parseCredentialsDocument(seeded, file)
    expect([...parsed.refs]).toEqual([["OPENCODE_API_KEY", "public"]])
  })

  test("publishes the installed zero-cost OpenCode catalog as OpenCode Free", () => {
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const patch = load(readFileSync(join(resources, "home/product.cordis.patch.yml"), "utf8")) as Array<{
      id?: string
      config?: Record<string, unknown>
    }>
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
    const resources = join(import.meta.dirname, "../../resources/dsh")
    const patch = load(readFileSync(join(resources, "home/product.cordis.patch.yml"), "utf8")) as Array<{
      id?: string
      disabled?: boolean
    }>

    expect(patch.find((entry) => entry.id === "llm-deepseek")?.disabled).toBe(true)
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
