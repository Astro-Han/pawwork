import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDshEnvironment,
  prepareDshProductHome,
  resolveDshPackagePath,
  resolveDshResources,
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

describe("DSH product home", () => {
  test("uses external packaged resources and source resources in development", () => {
    expect(
      resolveDshResources({
        appPath: "/Applications/PawWork.app/Contents/Resources/app.asar",
        isPackaged: true,
        resourcesPath: "/Applications/PawWork.app/Contents/Resources",
      }),
    ).toBe("/Applications/PawWork.app/Contents/Resources/dsh")
    expect(
      resolveDshResources({
        appPath: "/repo/packages/desktop-electron",
        isPackaged: false,
        resourcesPath: "/unused",
      }),
    ).toBe("/repo/packages/desktop-electron/resources/dsh")
  })

  test("runs packaged DSH from the real unpacked dependency tree", () => {
    expect(
      resolveDshPackagePath({
        isPackaged: true,
        resourcesPath: "/Applications/PawWork.app/Contents/Resources",
        resolveDevelopmentPackage: () => "/unused",
      }),
    ).toBe(
      "/Applications/PawWork.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/package.json",
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
    const resources = join(import.meta.dir, "../../resources/dsh")
    const credentials = join(productHome, ".credentials.yaml")
    writeFileSync(credentials, 'DEEPSEEK_API_KEY: "user-key"\n')

    const prepared = prepareDshProductHome({ productHome, resources })

    expect(readFileSync(credentials, "utf8")).toBe('DEEPSEEK_API_KEY: "user-key"\n')
    expect(readFileSync(prepared.patch, "utf8")).toContain("id: agent-default-model")
    expect(
      JSON.parse(readFileSync(join(productHome, "node_modules/@pawwork/dsh-product/package.json"), "utf8")).name,
    ).toBe("@pawwork/dsh-product")
    expect(prepared.zenIdentityPreload).toBe(join(resources, "zen-identity-preload.mjs"))
  })

  test("creates the public free-model credential for a fresh product home", () => {
    const productHome = join(temporaryDirectory(), "fresh")
    const resources = join(import.meta.dir, "../../resources/dsh")

    prepareDshProductHome({ productHome, resources })

    expect(readFileSync(join(productHome, ".credentials.yaml"), "utf8")).toBe('OPENCODE_API_KEY: "public"\n')
  })

  test("isolates DSH from ambient model credentials", () => {
    const environment = buildDshEnvironment("/data/dsh", {
      PATH: "/usr/bin",
      OPENCODE_API_KEY: "ambient",
      OPENCODE_GO_API_KEY: "ambient-go",
      DEEPSEEK_API_KEY: "ambient-deepseek",
      DEEPSEEK_BASE_URL: "https://example.test",
    })

    expect(environment).toEqual({ PATH: "/usr/bin", DSH_HOME: "/data/dsh" })
  })
})
