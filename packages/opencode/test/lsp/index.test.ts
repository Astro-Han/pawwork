import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import * as Lsp from "../../src/lsp/index"
import { LSPServer } from "../../src/lsp/server"
import { Settings } from "../../src/settings"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

function settings<A, E>(fn: (svc: Settings.Interface) => Effect.Effect<A, E>) {
  return AppRuntime.runPromise(Settings.Service.use(fn))
}

describe("lsp.spawn", () => {
  beforeEach(async () => {
    await settings((svc) => svc.setLspEnabled(true))
  })
  afterEach(async () => {
    await settings((svc) => svc.setLspEnabled(false))
  })

  test("does not spawn builtin LSP for files outside instance", async () => {
    await using tmp = await tmpdir()
    const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Lsp.LSP.touchFile(path.join(tmp.path, "..", "outside.ts"))
          await Lsp.LSP.hover({
            file: path.join(tmp.path, "..", "hover.ts"),
            line: 0,
            character: 0,
          })
        },
      })

      expect(spy).toHaveBeenCalledTimes(0)
    } finally {
      spy.mockRestore()
      await Instance.disposeAll()
    }
  })

  test("would spawn builtin LSP for files inside instance", async () => {
    await using tmp = await tmpdir()
    const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Lsp.LSP.hover({
            file: path.join(tmp.path, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
        },
      })

      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      await Instance.disposeAll()
    }
  })
})
