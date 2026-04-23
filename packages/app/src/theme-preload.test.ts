import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

const setMatchMedia = (prefersDark: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: prefersDark }) as MediaQueryList,
    configurable: true,
  })
}

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  setMatchMedia(false)
})

describe("theme preload", () => {
  test("defaults first-install users to pawwork light", () => {
    run()
    expect(document.documentElement.dataset.theme).toBe("pawwork")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("pawwork-color-scheme")).toBe("light")
  })

  test("preserves stored dark color scheme on pawwork", () => {
    localStorage.setItem("pawwork-theme-id", "pawwork")
    localStorage.setItem("pawwork-color-scheme", "dark")

    run()

    expect(document.documentElement.dataset.theme).toBe("pawwork")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(localStorage.getItem("pawwork-color-scheme")).toBe("dark")
  })

  test("resolves 'system' scheme against prefers-color-scheme", () => {
    localStorage.setItem("pawwork-theme-id", "pawwork")
    localStorage.setItem("pawwork-color-scheme", "system")
    setMatchMedia(true)

    run()

    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(localStorage.getItem("pawwork-color-scheme")).toBe("system")
  })

  for (const legacy of ["oc-1", "oc-2", "dracula", "nightowl", "amoled"]) {
    test(`migrates legacy "${legacy}" theme to pawwork and clears cached css, preserving scheme`, () => {
      localStorage.setItem("pawwork-theme-id", legacy)
      localStorage.setItem("pawwork-color-scheme", "dark")
      localStorage.setItem("pawwork-theme-css-light", "--background-base:#ffffff;")
      localStorage.setItem("pawwork-theme-css-dark", "--background-base:#000000;")

      run()

      expect(document.documentElement.dataset.theme).toBe("pawwork")
      expect(document.documentElement.dataset.colorScheme).toBe("dark")
      expect(localStorage.getItem("pawwork-theme-id")).toBe("pawwork")
      expect(localStorage.getItem("pawwork-color-scheme")).toBe("dark")
      expect(localStorage.getItem("pawwork-theme-css-light")).toBeNull()
      expect(localStorage.getItem("pawwork-theme-css-dark")).toBeNull()
    })
  }
})
