import { describe, expect, test } from "vitest"
import { decideDshNavigation, guardDshNavigation, handleDshWindowOpen } from "./window-navigation"

describe("DSH window navigation", () => {
  test("keeps the owned DSH origin in the secured main window", () => {
    expect(decideDshNavigation("http://127.0.0.1:53501/", "http://127.0.0.1:53501/session/1")).toBe("same-window")
    expect(decideDshNavigation("http://127.0.0.1:53501/", "http://127.0.0.1:9999/")).toBe("external")
  })

  test("opens public web links externally and rejects privileged schemes", () => {
    expect(decideDshNavigation("http://127.0.0.1:53501/", "https://github.com/deepseek-ai/DeepSeek-Harness")).toBe("external")
    expect(decideDshNavigation("http://127.0.0.1:53501/", "file:///tmp/secret")).toBe("deny")
    expect(decideDshNavigation("http://127.0.0.1:53501/", "javascript:alert(1)")).toBe("deny")
    expect(decideDshNavigation("http://127.0.0.1:53501/", "not a url")).toBe("deny")
  })

  test("prevents the main frame from leaving DSH and opens public links externally", async () => {
    let prevented = false
    const opened: string[] = []

    guardDshNavigation(
      "http://127.0.0.1:53501/",
      "https://example.com/help",
      { preventDefault: () => { prevented = true } },
      async (target) => { opened.push(target) },
    )
    await Promise.resolve()

    expect(prevented).toBe(true)
    expect(opened).toEqual(["https://example.com/help"])
  })

  // The decision is what keeps a privileged scheme out of the OS handler, so the
  // assertion that bites is the empty openExternal, not the preventDefault.
  test.each([
    "file:///tmp/secret",
    "javascript:alert(1)",
    "not a url",
  ])("blocks %s from reaching the OS handler", async (target) => {
    let prevented = false
    const opened: string[] = []

    guardDshNavigation(
      "http://127.0.0.1:53501/",
      target,
      { preventDefault: () => { prevented = true } },
      async (destination) => { opened.push(destination) },
    )
    await Promise.resolve()

    expect(prevented).toBe(true)
    expect(opened).toEqual([])
  })

  test.each([
    ["http://127.0.0.1:53501/session/1", ["http://127.0.0.1:53501/session/1"], []],
    ["https://example.com/help", [], ["https://example.com/help"]],
    ["file:///tmp/secret", [], []],
    ["javascript:alert(1)", [], []],
  ] as const)("denies the popup for %s and re-homes it by decision", async (target, loaded, opened) => {
    const loadedUrls: string[] = []
    const openedUrls: string[] = []

    const result = handleDshWindowOpen(
      "http://127.0.0.1:53501/",
      target,
      (destination) => loadedUrls.push(destination),
      async (destination) => { openedUrls.push(destination) },
    )
    await Promise.resolve()

    expect(result).toEqual({ action: "deny" })
    expect(loadedUrls).toEqual(loaded)
    expect(openedUrls).toEqual(opened)
  })

  test("allows the main frame to navigate within the owned DSH origin", () => {
    let prevented = false

    guardDshNavigation(
      "http://127.0.0.1:53501/",
      "http://127.0.0.1:53501/session/1",
      { preventDefault: () => { prevented = true } },
      async () => {},
    )

    expect(prevented).toBe(false)
  })
})
