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
