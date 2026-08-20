import { describe, expect, test } from "vitest"
import { detectSystemMenuLocale, menuRoleLabel } from "./menu-labels"

describe("menu labels", () => {
  test("detects supported system locale prefixes", () => {
    expect(detectSystemMenuLocale("zh-CN")).toBe("zh")
    expect(detectSystemMenuLocale("zh-TW")).toBe("zh")
    expect(detectSystemMenuLocale("zh-Hant-TW")).toBe("zh")
    expect(detectSystemMenuLocale("en-US")).toBe("en")
    expect(detectSystemMenuLocale("fr-FR")).toBe("en")
    expect(detectSystemMenuLocale(null)).toBe("en")
    expect(detectSystemMenuLocale(undefined)).toBe("en")
  })

  // The role labels are the only ones carrying a placeholder, and dsh-menu is
  // the only caller that fills it. Left unsubstituted, the macOS app menu reads
  // "About {appName}" — TypeScript cannot see it, because the labels are typed
  // as plain strings either way.
  test("substitutes the app name into every role label that asks for one", () => {
    for (const locale of ["en", "zh"] as const) {
      for (const key of ["about", "hide", "quit"] as const) {
        const label = menuRoleLabel(locale, key, "PawWork Dev")
        expect(label).toContain("PawWork Dev")
        expect(label).not.toContain("{appName}")
      }
    }
  })
})
