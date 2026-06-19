import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { Server } from "../../src/server/server"

afterEach(() => {
  mock.restore()
})

describe("UI route boundary", () => {
  test("proxies production UI catch-all requests through the native handler with CSP for inline theme preload", async () => {
    const inlineScript = "document.body.dataset.theme = 'dark'"
    let proxied: Request | undefined
    spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      proxied = input instanceof Request ? input : new Request(input, init)
      return new Response(`<html><script id="oc-theme-preload-script">${inlineScript}</script></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }) as typeof fetch)

    const response = await Server.Default().app.request(
      "/settings?workspace=ignored",
      {
        headers: {
          host: "localhost",
          "x-ui-test": "present",
        },
      },
    )

    const expectedHash = createHash("sha256").update(inlineScript).digest("base64")
    expect(proxied?.url).toBe("https://app.opencode.ai/settings")
    expect(proxied?.headers.get("host")).toBe("app.opencode.ai")
    expect(proxied?.headers.get("x-ui-test")).toBe("present")
    expect(response.headers.get("content-security-policy")).toContain(`'sha256-${expectedHash}'`)
    expect(await response.text()).toContain("oc-theme-preload-script")
  })
})
