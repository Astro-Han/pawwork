import { afterAll, describe, expect, mock, test } from "bun:test"

let constructorCalls = 0

mock.module("electron", () => ({
  app: { isPackaged: false },
}))

mock.module("electron-store", () => ({
  default: class Store {
    constructor() {
      constructorCalls++
    }
    get() {
      return null
    }
    set() {}
    delete() {}
  },
}))

afterAll(() => {
  mock.restore()
})

describe("desktop store", () => {
  test("does not instantiate electron-store at module import time", async () => {
    constructorCalls = 0
    // Keep this module instance isolated from other tests that may import ./store first.
    const { getStore } = await import(`./store?desktop-store-test=${crypto.randomUUID()}`)
    const storeName = `desktop-store-test-${crypto.randomUUID()}`

    expect(constructorCalls).toBe(0)
    getStore(storeName)
    expect(constructorCalls).toBe(1)
    getStore(storeName)
    expect(constructorCalls).toBe(1)
  })
})
