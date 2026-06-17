import { expect, test } from "bun:test"
import { normalizeLocale, t } from "./i18n.ts"

test("t renders per locale and substitutes {params}", () => {
  expect(t("en", "cmd.switchedTo", { x: "Foo" })).toBe("Switched to Foo.")
  expect(t("zh", "cmd.switchedTo", { x: "Foo" })).toBe("已切换到 Foo。")
  expect(t("zh", "cmd.onlyN", { n: 3 })).toBe("仅有 3 个近期会话。")
})

test("normalizeLocale coerces to a supported locale, defaulting to en", () => {
  expect(normalizeLocale("zh")).toBe("zh")
  expect(normalizeLocale("en")).toBe("en")
  expect(normalizeLocale(undefined)).toBe("en")
  expect(normalizeLocale(null)).toBe("en")
  expect(normalizeLocale("fr")).toBe("en")
})
