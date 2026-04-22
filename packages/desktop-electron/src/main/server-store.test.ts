import { afterAll, describe, expect, mock, test } from "bun:test"

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? "/tmp/pawwork-user-data" : `/tmp/${name}`),
    isPackaged: false,
  },
}))

const stores: string[] = []

mock.module("./store", () => ({
  getStore: (name?: string) => {
    stores.push(name ?? "default")
    return {
      get: () => null,
      set: () => undefined,
      delete: () => undefined,
    }
  },
}))

afterAll(() => {
  mock.restore()
})

describe("desktop server settings store", () => {
  test("resolves settings store lazily after server import", async () => {
    expect(stores).toEqual([])

    const { getDefaultServerUrl, setDefaultServerUrl, getWslConfig, setWslConfig } = await import("./server")

    expect(stores).toEqual([])
    expect(getDefaultServerUrl()).toBeNull()
    setDefaultServerUrl("http://127.0.0.1:4096")
    expect(getWslConfig()).toEqual({ enabled: false })
    setWslConfig({ enabled: true })
    expect(stores).toHaveLength(4)
    expect(stores.every((name) => name === "default")).toBe(true)
  })
})
