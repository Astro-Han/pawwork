import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { expect, test, vi } from "vitest"

async function configuredAdapter(providers: Record<string, unknown>) {
  const dsh = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json")
  const web = createRequire(dsh).resolve("@deepseek-ai/dsh-web-app/package.json")
  const entry = createRequire(web).resolve("@deepseek-ai/dsh-llm-pi-ai")
  const { apply, Config } = await import(pathToFileURL(entry).href)
  let adapter: {
    resolveModel: (provider: string, model: string) => Promise<{ id: string; name: string }>
    prepareCall: (provider: string, model: string) => Promise<{
      stream: (options: unknown) => AsyncIterable<unknown>
    }>
  }
  const noop = () => {}
  apply({
    fiber: {}, inject: noop, on: noop,
    get: (name: string) => name === "credentials" ? { resolve: async () => ({ value: "test-key" }) } : undefined,
    logger: { warn: noop, error: noop },
    llm: {
      registerAdapter: (_routes: unknown, installed: typeof adapter) => { adapter = installed; return { replace: noop } },
      registerConfigurableProviders: () => ({ replace: noop }),
      registerModelDiscovery: noop,
    },
  }, Config({ providers }))
  return adapter!
}

test("saved DeepSeek Flash aliases resolve and send the canonical model", async () => {
  const adapter = await configuredAdapter({ deepseek: { apiKeyEnv: "TEST_KEY" } })
  const sent: string[] = []
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)).model)
    const chunks = [
      { id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  })
  try {
    for (const model of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(await adapter.resolveModel("deepseek", model)).toMatchObject({ id: model })
      const call = await adapter.prepareCall("deepseek", model)
      for await (const chunk of call.stream({ provider: "deepseek", model, messages: [], tools: [] })) void chunk
    }
    expect(sent).toEqual(["deepseek-flash", "deepseek-flash"])
  } finally {
    fetch.mockRestore()
  }
})

test("custom DeepSeek endpoints and explicit legacy models retain their own IDs", async () => {
  const custom = await configuredAdapter({ deepseek: { baseURL: "https://models.example/v1" } })
  await expect(custom.resolveModel("deepseek", "deepseek-v4-flash")).rejects.toMatchObject({ code: "UNKNOWN_MODEL" })
  const explicit = await configuredAdapter({ deepseek: { models: [{ id: "deepseek-v4-flash", name: "Private Flash" }] } })
  expect(await explicit.resolveModel("deepseek", "deepseek-v4-flash")).toMatchObject({ id: "deepseek-v4-flash", name: "Private Flash" })
  const namedRoute = await configuredAdapter({ custom: {
    api: "openai-completions", baseURL: "https://api.deepseek.com", models: [{ id: "deepseek-flash" }],
  } })
  await expect(namedRoute.resolveModel("custom", "deepseek-v4-flash")).rejects.toMatchObject({ code: "UNKNOWN_MODEL" })
})
