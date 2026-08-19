import { describe, expect, test } from "vitest"
import { decideDshNavigation, guardDshNavigation } from "./window-navigation"

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
