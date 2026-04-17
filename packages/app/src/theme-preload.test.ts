import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("uses PawWork as the empty-storage default theme", () => {
    run()
    expect(document.documentElement.dataset.theme).toBe("pawwork")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
  })

  test("locks PawWork to light regardless of stored color scheme", () => {
    localStorage.setItem("opencode-theme-id", "pawwork")
    localStorage.setItem("opencode-color-scheme", "dark")
    run()
    expect(document.documentElement.dataset.theme).toBe("pawwork")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
  })

  test("preserves stored PawWork and keeps color scheme locked to light", () => {
    localStorage.setItem("opencode-theme-id", "pawwork")
    localStorage.setItem("opencode-color-scheme", "dark")

    run()

    expect(document.documentElement.dataset.theme).toBe("pawwork")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("opencode-theme-id")).toBe("pawwork")
    expect(localStorage.getItem("opencode-color-scheme")).toBe("light")
  })

  for (const legacy of ["oc-1", "oc-2", "dracula", "nightowl", "amoled"]) {
    test(`migrates legacy "${legacy}" theme to pawwork and clears cached css`, () => {
      localStorage.setItem("opencode-theme-id", legacy)
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem("opencode-theme-css-light", "--background-base:#ffffff;")
      localStorage.setItem("opencode-theme-css-dark", "--background-base:#000000;")

      run()

      expect(document.documentElement.dataset.theme).toBe("pawwork")
      expect(document.documentElement.dataset.colorScheme).toBe("light")
      expect(localStorage.getItem("opencode-theme-id")).toBe("pawwork")
      expect(localStorage.getItem("opencode-color-scheme")).toBe("light")
      expect(localStorage.getItem("opencode-theme-css-light")).toBeNull()
      expect(localStorage.getItem("opencode-theme-css-dark")).toBeNull()
    })
  }
})
