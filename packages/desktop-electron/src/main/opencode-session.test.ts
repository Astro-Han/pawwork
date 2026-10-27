import { describe, expect, test } from "vitest"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { isOpenCodeUrl } from "../../resources/dsh/opencode-session.mjs"

async function catalogBaseUrls(provider: string) {
  const require = createRequire(import.meta.url)
  const dshPackage = require.resolve("@deepseek-ai/dsh/package.json")
  const webAppPackage = createRequire(dshPackage).resolve("@deepseek-ai/dsh-web-app/package.json")
  const adapterPackage = createRequire(webAppPackage).resolve("@deepseek-ai/dsh-llm-pi-ai/package.json")
  const catalogPath = join(dirname(adapterPackage), "..", "..", "@earendil-works", "pi-ai", "dist/providers/all.js")
  const catalog = (await import(pathToFileURL(catalogPath).href)) as {
    getAllBuiltinModels: (provider: string) => { baseUrl: string }[]
  }
  return [...new Set(catalog.getAllBuiltinModels(provider).map((model) => model.baseUrl))]
}

describe("OpenCode session preload", () => {
  test("covers every endpoint the bundled opencode-go catalog sends to", async () => {
    const urls = await catalogBaseUrls("opencode-go")

    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect([url, isOpenCodeUrl(`${url}/chat/completions`)]).toEqual([url, true])
  })

  test("leaves other hosts alone", () => {
    expect(isOpenCodeUrl("https://api.deepseek.com/v1/chat/completions")).toBe(false)
    expect(isOpenCodeUrl("https://opencode.ai/docs")).toBe(false)
  })
})
