import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { JSONValue } from "ai"
import { generateText } from "ai"
import { createAiGateway } from "ai-gateway-provider"
import { createUnified } from "ai-gateway-provider/providers/unified"
import { ProviderTransform } from "@/provider/transform"
import type * as Provider from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"

type Captured = { url: string; outerBody: unknown }
type ProviderOptions = Record<string, Record<string, JSONValue>>

const realFetch = globalThis.fetch
let captured: Captured[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

beforeEach(() => {
  captured = []
  const handle = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) {
      const bodyText = typeof init?.body === "string" ? init.body : ""
      captured.push({ url, outerBody: bodyText ? JSON.parse(bodyText) : null })
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "openai/gpt-5.4",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    return realFetch(input, init)
  }
  globalThis.fetch = Object.assign(handle, { preconnect: realFetch.preconnect.bind(realFetch) })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const cfModel = (apiId: string, releaseDate = "2026-03-05"): Provider.Model => ({
  id: ModelID.make(`cloudflare-ai-gateway/${apiId}`),
  providerID: ProviderID.make("cloudflare-ai-gateway"),
  name: apiId,
  api: { id: apiId, url: "https://gateway.ai.cloudflare.com/v1/compat", npm: "ai-gateway-provider" },
  capabilities: {
    reasoning: true,
    temperature: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
  limit: { context: 1_000_000, output: 128_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: releaseDate,
})

function extractUpstreamQuery(body: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(body) || body.length === 0) return undefined
  const first = body[0]
  if (!isRecord(first)) return undefined
  const query = first.query
  return isRecord(query) ? query : undefined
}

async function callThroughGateway(apiId: string, providerOptions: ProviderOptions) {
  const aigateway = createAiGateway({ accountId: "test", gateway: "test", apiKey: "test" })
  const unified = createUnified()
  await generateText({ model: aigateway(unified(apiId)), prompt: "hi", providerOptions })
  return captured.map((entry) => extractUpstreamQuery(entry.outerBody)).find((query) => query !== undefined)
}

describe("cf-ai-gateway provider options", () => {
  test("ProviderTransform.providerOptions output puts reasoning_effort on the wire", async () => {
    const opts = ProviderTransform.providerOptions(cfModel("openai/gpt-5.4"), { reasoningEffort: "xhigh" })
    expect(opts).toEqual({ openaiCompatible: { reasoningEffort: "xhigh" } })

    const upstream = await callThroughGateway("openai/gpt-5.4", opts)
    expect(upstream?.reasoning_effort).toBe("xhigh")
  })

  test("variants output for openai/gpt-5.4 lands xhigh on the wire", async () => {
    const variants = ProviderTransform.variants(cfModel("openai/gpt-5.4"))
    expect(variants.xhigh).toEqual({ reasoningEffort: "xhigh" })

    const opts = ProviderTransform.providerOptions(cfModel("openai/gpt-5.4"), variants.xhigh)
    const upstream = await callThroughGateway("openai/gpt-5.4", opts)
    expect(upstream?.reasoning_effort).toBe("xhigh")
  })
})
