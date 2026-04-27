import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import fs from "node:fs"
import path from "path"
import { LSP } from "../../src/lsp"
import { LSPServer, LSP_SERVER_PACKAGES } from "../../src/lsp/server"
import { Settings } from "../../src/settings"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const it = testEffect(Layer.mergeAll(infra, LSP.defaultLayer, Settings.defaultLayer))

const resetSettings = Effect.gen(function* () {
  const settings = yield* Settings.Service
  yield* settings.setLspEnabled(false)
})

describe("LSP gate", () => {
  it.live("when lspEnabled=false, no server registers and spawn is never called", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
        try {
          const settings = yield* Settings.Service
          yield* settings.setLspEnabled(false)
          const lsp = yield* LSP.Service
          const has = yield* lsp.hasClients(path.join(dir, "test.ts"))
          expect(has).toBe(false)
          yield* lsp.touchFile(path.join(dir, "test.ts"))
          expect(spy).toHaveBeenCalledTimes(0)
        } finally {
          spy.mockRestore()
          yield* resetSettings
        }
      }),
    ),
  )

  it.live("when lspEnabled=true, servers register and spawn is attempted", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
        try {
          const settings = yield* Settings.Service
          yield* settings.setLspEnabled(true)
          const lsp = yield* LSP.Service
          const has = yield* lsp.hasClients(path.join(dir, "test.ts"))
          expect(has).toBe(true)
          yield* lsp.touchFile(path.join(dir, "test.ts"))
          expect(spy).toHaveBeenCalledTimes(1)
        } finally {
          spy.mockRestore()
          yield* resetSettings
        }
      }),
    ),
  )

  it.live("shutdownAll resolves cleanly when no state is initialized", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const lsp = yield* LSP.Service
        yield* lsp.shutdownAll()
      }),
    ),
  )

  it.live("invalidate forces state re-init so flip-on becomes observable", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
        try {
          const settings = yield* Settings.Service
          const lsp = yield* LSP.Service

          yield* settings.setLspEnabled(false)
          const off = yield* lsp.hasClients(path.join(dir, "test.ts"))
          expect(off).toBe(false)

          yield* settings.setLspEnabled(true)
          yield* lsp.invalidate()
          const on = yield* lsp.hasClients(path.join(dir, "test.ts"))
          expect(on).toBe(true)
        } finally {
          spy.mockRestore()
          yield* resetSettings
        }
      }),
    ),
  )
})

describe("LSP package metadata", () => {
  test("LSP_SERVER_PACKAGES contains TypeScript and Vue language server packages", () => {
    expect(LSP_SERVER_PACKAGES.has("typescript-language-server")).toBe(true)
    expect(LSP_SERVER_PACKAGES.has("@vue/language-server")).toBe(true)
  })

  test("install failures take the .catch branch with cooldown instead of s.broken poison", () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, "..", "..", "src", "lsp", "index.ts"),
      "utf8",
    )
    expect(src.includes("InstallFailedError")).toBe(true)
    const catchSection = src.slice(
      src.indexOf(".catch((err)"),
      src.indexOf(".catch((err)") + 800,
    )
    expect(catchSection.includes("isInstallFailure")).toBe(true)
    expect(catchSection.includes("installCooldownUntil")).toBe(true)
    expect(catchSection.includes("s.broken.add(key)")).toBe(true)
  })
})
