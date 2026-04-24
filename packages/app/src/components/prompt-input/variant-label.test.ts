import { describe, expect, test } from "bun:test"
import { KNOWN_VARIANTS, translateVariant } from "./variant-label"

const zhT = ((key: string) =>
  ({
    "common.default": "默认",
    "variant.none": "无",
    "variant.minimal": "极低",
    "variant.low": "低",
    "variant.medium": "中",
    "variant.high": "高",
    "variant.xhigh": "超高",
    "variant.max": "最高",
  })[key]) as any

const enT = ((key: string) =>
  ({
    "common.default": "Default",
    "variant.none": "None",
    "variant.minimal": "Minimal",
    "variant.low": "Low",
    "variant.medium": "Medium",
    "variant.high": "High",
    "variant.xhigh": "Extra High",
    "variant.max": "Max",
  })[key]) as any

const missingT = (() => undefined) as any

describe("translateVariant", () => {
  test("default reuses common.default (zh)", () => {
    expect(translateVariant(zhT, "default")).toBe("默认")
  })

  test("default reuses common.default (en)", () => {
    expect(translateVariant(enT, "default")).toBe("Default")
  })

  test("every whitelist key resolves in zh", () => {
    for (const key of KNOWN_VARIANTS) {
      const result = translateVariant(zhT, key)
      expect(result).not.toBe(key)
      expect(typeof result).toBe("string")
    }
  })

  test("every whitelist key resolves in en", () => {
    for (const key of KNOWN_VARIANTS) {
      const result = translateVariant(enT, key)
      expect(result).not.toBe(key)
      expect(typeof result).toBe("string")
    }
  })

  test("xhigh maps to 超高 / Extra High", () => {
    expect(translateVariant(zhT, "xhigh")).toBe("超高")
    expect(translateVariant(enT, "xhigh")).toBe("Extra High")
  })

  test("minimal maps to 极低 / Minimal", () => {
    expect(translateVariant(zhT, "minimal")).toBe("极低")
    expect(translateVariant(enT, "minimal")).toBe("Minimal")
  })

  test("unknown key returns raw input (future provider-introduced key)", () => {
    expect(translateVariant(zhT, "ultra-max")).toBe("ultra-max")
  })

  test("missing translator entry falls back to raw key (defensive)", () => {
    expect(translateVariant(missingT, "low")).toBe("low")
    expect(translateVariant(missingT, "default")).toBe("default")
  })
})
