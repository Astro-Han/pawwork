import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  extractRuntimeImports,
  findTsSourceRuntimeImports,
  findWorkspacePackageJsonPath,
  packageExportsTypeScriptSourceForSpecifier,
  packageNameForSpecifier,
  readBuiltRuntimeFiles,
  runRuntimeImportGuard,
} from "./runtime-import-guard"

describe("runtime import guard", () => {
  test("extractRuntimeImports finds static and dynamic runtime imports", () => {
    const source = `
      import "side-effect";import { NamedError } from "@opencode-ai/util/error"
      import "@opencode-ai/shared/runtime";const cjs = require("@opencode-ai/sdk")
      const lazy = import("@opencode-ai/plugin")
      const templated = import(\`@opencode-ai/util/template\`)
      export * from "@opencode-ai/util/re-export-all"
      export { NamedError as ExportedNamedError } from "@opencode-ai/util/re-export-named"
      export type { Foo as ExportedFoo } from "@opencode-ai/util/exported-type"
      import type { Foo } from "@opencode-ai/util/foo"
      const label = "@opencode-ai/util/not-an-import"
    `

    expect(extractRuntimeImports(source)).toEqual([
      { kind: "import", specifier: "side-effect" },
      { kind: "import", specifier: "@opencode-ai/util/error" },
      { kind: "import", specifier: "@opencode-ai/shared/runtime" },
      { kind: "require", specifier: "@opencode-ai/sdk" },
      { kind: "import", specifier: "@opencode-ai/plugin" },
      { kind: "import", specifier: "@opencode-ai/util/template" },
      { kind: "import", specifier: "@opencode-ai/util/re-export-all" },
      { kind: "import", specifier: "@opencode-ai/util/re-export-named" },
    ])
  })

  test("packageNameForSpecifier returns the scoped package name", () => {
    expect(packageNameForSpecifier("@opencode-ai/util/error")).toBe("@opencode-ai/util")
    expect(packageNameForSpecifier("@opencode-ai/shared/runtime")).toBe("@opencode-ai/shared")
    expect(packageNameForSpecifier("electron-store")).toBe("electron-store")
  })

  test("packageExportsTypeScriptSourceForSpecifier detects the imported runtime subpath", () => {
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { "./*": "./src/*.ts" } },
        "@opencode-ai/util",
        "@opencode-ai/util/error",
        "import",
      ),
    ).toBe(true)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { ".": "./src/index.ts", "./tool": "./src/tool.ts" } },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin",
        "import",
      ),
    ).toBe(true)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { import: "./src/index.ts", require: "./dist/index.cjs" } },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin",
        "import",
      ),
    ).toBe(true)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { import: "./src/index.ts", require: "./dist/index.cjs" } },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin",
        "require",
      ),
    ).toBe(false)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { ".": { types: "./src/index.d.ts", import: "./dist/index.js" } } },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin",
        "import",
      ),
    ).toBe(false)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { ".": "./dist/index.js", "./tool": "./src/tool.ts" } },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin",
        "import",
      ),
    ).toBe(false)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { exports: { "./*": "./dist/*.js", "./foo/*": "./src/foo/*.ts" } },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin/foo/bar",
        "import",
      ),
    ).toBe(true)
    expect(
      packageExportsTypeScriptSourceForSpecifier(
        { main: "./dist/index.js" },
        "@opencode-ai/plugin",
        "@opencode-ai/plugin",
        "import",
      ),
    ).toBe(false)
  })

  test("findWorkspacePackageJsonPath resolves nested workspace packages such as sdk", () => {
    const root = path.resolve(import.meta.dir, "..")

    expect(findWorkspacePackageJsonPath(root, "@opencode-ai/sdk")).toBe(path.resolve(root, "../sdk/js/package.json"))
  })

  test("findWorkspacePackageJsonPath discovers the workspace root from nested directories", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "pawwork-runtime-guard-repo-"))
    try {
      await Bun.write(path.join(repo, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }))
      mkdirSync(path.join(repo, "packages/util"), { recursive: true })
      mkdirSync(path.join(repo, "apps/desktop/scripts"), { recursive: true })
      await Bun.write(path.join(repo, "packages/util/package.json"), JSON.stringify({ name: "@opencode-ai/util" }))

      expect(findWorkspacePackageJsonPath(path.join(repo, "apps/desktop/scripts"), "@opencode-ai/util")).toBe(
        path.join(repo, "packages/util/package.json"),
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("readBuiltRuntimeFiles fails when no runtime JavaScript files were scanned", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pawwork-runtime-guard-"))
    try {
      expect(() => readBuiltRuntimeFiles(dir)).toThrow("No Electron main/preload JavaScript output files found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("readBuiltRuntimeFiles reads main and preload JavaScript output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pawwork-runtime-guard-"))
    try {
      mkdirSync(path.join(dir, "out/main"), { recursive: true })
      mkdirSync(path.join(dir, "out/preload"), { recursive: true })
      await Bun.write(path.join(dir, "out/main/index.js"), 'import "@opencode-ai/util/error"')
      await Bun.write(path.join(dir, "out/preload/index.mjs"), 'import "@opencode-ai/shared/runtime"')

      expect(readBuiltRuntimeFiles(dir)).toEqual([
        { file: path.join("out/main/index.js"), source: 'import "@opencode-ai/util/error"' },
        { file: path.join("out/preload/index.mjs"), source: 'import "@opencode-ai/shared/runtime"' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("findTsSourceRuntimeImports reports opencode runtime imports backed by TypeScript exports", () => {
    const findings = findTsSourceRuntimeImports(
      [
        {
          file: "out/main/index.js",
          source: 'import { NamedError } from "@opencode-ai/util/error"',
        },
        {
          file: "out/main/chunks/node.js",
          source: 'const dependency = require("@opencode-ai/plugin")',
        },
        {
          file: "out/preload/index.mjs",
          source: 'import Store from "electron-store"',
        },
      ],
      new Map([
        ["@opencode-ai/util", { exports: { "./*": "./src/*.ts" } }],
        ["@opencode-ai/plugin", { exports: { import: "./src/index.ts", require: "./dist/index.cjs" } }],
      ]),
    )

    expect(findings).toEqual([
      {
        file: "out/main/index.js",
        specifier: "@opencode-ai/util/error",
        packageName: "@opencode-ai/util",
      },
    ])
  })

  test("runRuntimeImportGuard fails closed when an opencode package cannot be resolved", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pawwork-runtime-guard-"))
    try {
      await Bun.write(path.join(dir, "package.json"), JSON.stringify({ workspaces: { packages: [] } }))
      mkdirSync(path.join(dir, "out/main"), { recursive: true })
      await Bun.write(path.join(dir, "out/main/index.js"), 'import "@opencode-ai/missing"')

      expect(() => runRuntimeImportGuard(dir)).toThrow(
        "Could not resolve package.json for runtime imports: @opencode-ai/missing",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
