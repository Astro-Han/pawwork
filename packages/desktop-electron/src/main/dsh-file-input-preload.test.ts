import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import vm from "node:vm"
import { describe, expect, mock, test } from "bun:test"

const preloadPath = resolve(import.meta.dir, "../../resources/dsh/product/preload.cjs")

describe("PawWork DSH file input preload", () => {
  test("exposes only a no-argument native file picker", async () => {
    const invoke = mock(async () => ({ status: "canceled" }))
    let exposed: { name: string; api: Record<string, () => Promise<unknown>> } | undefined
    const contextBridge = {
      exposeInMainWorld: (name: string, api: Record<string, () => Promise<unknown>>) => {
        exposed = { name, api }
      },
    }

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      require: (name: string) => {
        if (name === "electron") return { contextBridge, ipcRenderer: { invoke } }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect(exposed?.name).toBe("pawworkFiles")
    expect(Object.keys(exposed?.api ?? {})).toEqual(["pick"])
    await exposed!.api.pick()
    expect(invoke).toHaveBeenCalledWith("pawwork:pick-conversation-files")
  })
})
