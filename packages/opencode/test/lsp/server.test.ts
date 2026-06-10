import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import fs from "node:fs"
import path from "node:path"
import { LSPServer } from "../../src/lsp/server"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const it = testEffect(infra)

describe("JavascriptPackageRoot", () => {
  it.live("prepends tsconfig.json and package.json before lockfiles", () =>
    Effect.sync(() => {
      const list = LSPServer.JavascriptPackageRoot()
      expect(list[0]).toBe("tsconfig.json")
      expect(list[1]).toBe("package.json")
      expect(list).toContain("bun.lock")
    }),
  )
})

describe("Typescript root resolution", () => {
  it.live("resolves to nearest tsconfig.json, not monorepo lockfile", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(root, "bun.lock"), "")
        fs.mkdirSync(path.join(root, "packages/app/src"), { recursive: true })
        fs.writeFileSync(path.join(root, "packages/app/tsconfig.json"), "{}")
        fs.writeFileSync(path.join(root, "packages/app/src/foo.ts"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.Typescript.root(path.join(root, "packages/app/src/foo.ts")),
        )
        expect(resolved).toBe(path.join(root, "packages/app"))
      }),
    ),
  )
})

describe("JDTLS root resolution", () => {
  it.live("resolves Maven module files to the topmost declared parent pom.xml", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.writeFileSync(
          path.join(root, "pom.xml"),
          `
<project>
  <modules>
    <module>modules/core</module>
  </modules>
</project>
`,
        )
        fs.mkdirSync(path.join(root, "modules/core/src/main/java/app"), { recursive: true })
        fs.writeFileSync(path.join(root, "modules/core/pom.xml"), "<project />")
        fs.writeFileSync(path.join(root, "modules/core/src/main/java/app/App.java"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.JDTLS.root(path.join(root, "modules/core/src/main/java/app/App.java")),
        )
        expect(resolved).toBe(root)
      }),
    ),
  )

  it.live("keeps independent nested Maven projects at their nearest pom.xml", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(root, "pom.xml"), "<project />")
        fs.mkdirSync(path.join(root, "samples/tool/src/main/java/app"), { recursive: true })
        fs.writeFileSync(path.join(root, "samples/tool/pom.xml"), "<project />")
        fs.writeFileSync(path.join(root, "samples/tool/src/main/java/app/App.java"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.JDTLS.root(path.join(root, "samples/tool/src/main/java/app/App.java")),
        )
        expect(resolved).toBe(path.join(root, "samples/tool"))
      }),
    ),
  )

  it.live("ignores Maven modules inside XML comments", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.writeFileSync(
          path.join(root, "pom.xml"),
          `
<project>
  <!--
  <modules>
    <module>samples/tool</module>
  </modules>
  -->
</project>
`,
        )
        fs.mkdirSync(path.join(root, "samples/tool/src/main/java/app"), { recursive: true })
        fs.writeFileSync(path.join(root, "samples/tool/pom.xml"), "<project />")
        fs.writeFileSync(path.join(root, "samples/tool/src/main/java/app/App.java"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.JDTLS.root(path.join(root, "samples/tool/src/main/java/app/App.java")),
        )
        expect(resolved).toBe(path.join(root, "samples/tool"))
      }),
    ),
  )

  it.live("keeps Gradle settings root ahead of Maven subproject markers", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(root, "settings.gradle"), "include 'app'")
        fs.mkdirSync(path.join(root, "app/src/main/java/app"), { recursive: true })
        fs.writeFileSync(path.join(root, "app/pom.xml"), "<project />")
        fs.writeFileSync(path.join(root, "app/src/main/java/app/App.java"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.JDTLS.root(path.join(root, "app/src/main/java/app/App.java")),
        )
        expect(resolved).toBe(root)
      }),
    ),
  )

  it.live("keeps Eclipse project markers ahead of ancestor Maven markers", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(root, "pom.xml"), "<project />")
        fs.mkdirSync(path.join(root, "legacy/src/app"), { recursive: true })
        fs.writeFileSync(path.join(root, "legacy/.project"), "")
        fs.writeFileSync(path.join(root, "legacy/src/app/App.java"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.JDTLS.root(path.join(root, "legacy/src/app/App.java")),
        )
        expect(resolved).toBe(path.join(root, "legacy"))
      }),
    ),
  )

  it.live("keeps no-marker Java files at the instance root", () =>
    provideTmpdirInstance((root) =>
      Effect.gen(function* () {
        fs.mkdirSync(path.join(root, "src/main/java/app"), { recursive: true })
        fs.writeFileSync(path.join(root, "src/main/java/app/App.java"), "")

        const resolved = yield* Effect.promise(() =>
          LSPServer.JDTLS.root(path.join(root, "src/main/java/app/App.java")),
        )
        expect(resolved).toBe(root)
      }),
    ),
  )
})
