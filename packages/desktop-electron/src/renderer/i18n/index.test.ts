import { beforeEach, describe, expect, test } from "bun:test"

let nextStoreValue: unknown = null

beforeEach(() => {
  nextStoreValue = null
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "en", languages: ["en"] },
  })
  Object.defineProperty(globalThis, "api", {
    configurable: true,
    value: {
      storeGet: async () => nextStoreValue,
    },
  })
})

async function loadI18n() {
  return import(`./index.ts?test=${Date.now()}-${Math.random()}`)
}

describe("desktop renderer i18n locale normalization", () => {
  test("maps Traditional Chinese browser tags to Simplified Chinese", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "zh-Hant", languages: ["zh-Hant", "en"] },
    })

    const i18n = await loadI18n()

    expect(await i18n.initI18n()).toBe("zh")
  })

  test("maps legacy stored zht object locale to Simplified Chinese", async () => {
    nextStoreValue = JSON.stringify({ locale: "zht" })

    const i18n = await loadI18n()

    expect(await i18n.initI18n()).toBe("zh")
  })

  test("maps legacy stored direct zht locale to Simplified Chinese", async () => {
    nextStoreValue = "zht"

    const i18n = await loadI18n()

    expect(await i18n.initI18n()).toBe("zh")
  })

  test("normalizes stored uppercase English before falling back to browser language", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language: "zh-Hant", languages: ["zh-Hant"] },
    })
    nextStoreValue = JSON.stringify({ locale: "EN" })

    const i18n = await loadI18n()

    expect(await i18n.initI18n()).toBe("en")
  })
})
