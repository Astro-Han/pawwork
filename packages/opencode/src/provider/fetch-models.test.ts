import { expect, test } from "bun:test"
import { FetchModels } from "@/provider/fetch-models"

test("parses OpenAI-compatible { data: [...] } shape", () => {
  expect(FetchModels.parse({ data: [{ id: "a" }, { id: "b", name: "Model B" }] })).toEqual([
    { id: "a", name: "a" },
    { id: "b", name: "Model B" },
  ])
})

test("uses Anthropic display_name when normalizing a model list", () => {
  expect(FetchModels.parse({ data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }] })).toEqual([
    { id: "claude-sonnet", name: "Claude Sonnet" },
  ])
})

test("parses { models: [...] } shape", () => {
  expect(FetchModels.parse({ models: [{ id: "m" }] })).toEqual([{ id: "m", name: "m" }])
})

test("parses a bare array shape", () => {
  expect(FetchModels.parse([{ id: "x" }])).toEqual([{ id: "x", name: "x" }])
})

test("dedups repeated ids and keeps the first", () => {
  expect(FetchModels.parse({ data: [{ id: "a", name: "first" }, { id: "a", name: "second" }] })).toEqual([
    { id: "a", name: "first" },
  ])
})

test("skips rows without a usable string id", () => {
  expect(FetchModels.parse({ data: [{ id: "" }, { foo: 1 }, { id: 5 }, { id: "ok" }] })).toEqual([
    { id: "ok", name: "ok" },
  ])
})

test("returns an empty list for a valid but empty response", () => {
  expect(FetchModels.parse({ data: [] })).toEqual([])
})

test("throws on an unrecognized response shape", () => {
  expect(() => FetchModels.parse({ error: "unauthorized" })).toThrow()
  expect(() => FetchModels.parse("nope")).toThrow()
})

test("builds the /models endpoint and normalizes trailing slashes", () => {
  expect(FetchModels.endpoint("https://gateway.example/v1")).toBe("https://gateway.example/v1/models")
  expect(FetchModels.endpoint("https://gateway.example/v1/")).toBe("https://gateway.example/v1/models")
  expect(FetchModels.endpoint("  https://gateway.example/v1//  ")).toBe("https://gateway.example/v1/models")
})

test("request: base URL precedence is endpoint > baseURL > catalog", () => {
  expect(
    FetchModels.request({
      configOptions: { endpoint: "https://endpoint.example", baseURL: "https://base.example" },
      catalogBaseURL: "https://catalog.example",
    })?.baseURL,
  ).toBe("https://endpoint.example")
  expect(
    FetchModels.request({ configOptions: { baseURL: "https://base.example" }, catalogBaseURL: "https://catalog.example" })
      ?.baseURL,
  ).toBe("https://base.example")
  expect(FetchModels.request({ catalogBaseURL: "https://catalog.example" })?.baseURL).toBe("https://catalog.example")
})

test("request: returns undefined when no base URL is known", () => {
  expect(FetchModels.request({})).toBeUndefined()
  expect(FetchModels.request({ configOptions: {} })).toBeUndefined()
})

test("request: copies string config headers and drops non-string values", () => {
  const result = FetchModels.request({
    catalogBaseURL: "https://catalog.example",
    configOptions: { headers: { "X-Title": "pawwork", "X-Bad": 5 as unknown as string } },
  })
  expect(result?.headers).toEqual({ "X-Title": "pawwork" })
})

test("request: adds a Bearer header from the auth key, preferring it over a config apiKey", () => {
  expect(
    FetchModels.request({ catalogBaseURL: "https://catalog.example", authKey: "auth-key" })?.headers["Authorization"],
  ).toBe("Bearer auth-key")
  expect(
    FetchModels.request({ catalogBaseURL: "https://catalog.example", configOptions: { apiKey: "config-key" } })?.headers[
      "Authorization"
    ],
  ).toBe("Bearer config-key")
  expect(
    FetchModels.request({
      catalogBaseURL: "https://catalog.example",
      authKey: "auth-key",
      configOptions: { apiKey: "config-key" },
    })?.headers["Authorization"],
  ).toBe("Bearer auth-key")
})

test("request: does not overwrite an explicit Authorization header from config", () => {
  const result = FetchModels.request({
    catalogBaseURL: "https://catalog.example",
    authKey: "auth-key",
    configOptions: { headers: { authorization: "Token preset" } },
  })
  expect(result?.headers).toEqual({ authorization: "Token preset" })
})

test("resolves Kimi model discovery independently of its Anthropic inference adapter", () => {
  expect(
    FetchModels.resolve({
      providerID: "kimi-for-coding",
      providerNPMs: ["@ai-sdk/anthropic"],
      catalogBaseURL: "https://api.kimi.com/coding/v1",
      authKey: "kimi-key",
    }),
  ).toEqual({
    endpoint: "https://api.kimi.com/coding/v1/models",
    headers: { Authorization: "Bearer kimi-key" },
  })
})

test("uses MiniMax's OpenAI-compatible endpoint for model discovery", () => {
  expect(
    FetchModels.resolve({
      providerID: "minimax",
      providerNPMs: ["@ai-sdk/anthropic"],
      catalogBaseURL: "https://api.minimax.io/anthropic/v1",
      authKey: "minimax-key",
    }),
  ).toEqual({
    endpoint: "https://api.minimax.io/v1/models",
    headers: { Authorization: "Bearer minimax-key" },
  })
})

test("uses the region-specific OpenAI-compatible endpoint for MiniMax variants", () => {
  const providers = [
    ["minimax-coding-plan", "https://api.minimax.io/v1"],
    ["minimax-cn", "https://api.minimaxi.com/v1"],
    ["minimax-cn-coding-plan", "https://api.minimaxi.com/v1"],
  ] as const

  for (const [providerID, discoveryBaseURL] of providers) {
    expect(
      FetchModels.resolve({
        providerID,
        providerNPMs: ["@ai-sdk/anthropic"],
        authKey: "minimax-key",
      }),
    ).toEqual({
      endpoint: `${discoveryBaseURL}/models`,
      headers: { Authorization: "Bearer minimax-key" },
    })
  }
})

test("resolves Anthropic discovery with its native base URL and version header", () => {
  expect(
    FetchModels.resolve({
      providerID: "anthropic",
      providerNPMs: ["@ai-sdk/anthropic"],
      authKey: "anthropic-key",
    }),
  ).toEqual({
    endpoint: "https://api.anthropic.com/v1/models",
    headers: {
      "X-Api-Key": "anthropic-key",
      "anthropic-version": "2023-06-01",
    },
  })
})

test("resolves a dual-protocol provider that shares one OpenAI-compatible base URL", () => {
  expect(
    FetchModels.resolve({
      providerID: "freemodel",
      providerNPMs: ["@ai-sdk/anthropic"],
      catalogBaseURL: "https://cc.freemodel.dev/v1",
    }),
  ).toEqual({
    endpoint: "https://cc.freemodel.dev/v1/models",
    headers: {},
  })
})

test("resolves Subconscious discovery despite its Anthropic inference adapter", () => {
  expect(
    FetchModels.resolve({
      providerID: "subconscious",
      providerNPMs: ["@ai-sdk/anthropic"],
      catalogBaseURL: "https://api.subconscious.dev/v1",
      authKey: "subconscious-key",
    }),
  ).toEqual({
    endpoint: "https://api.subconscious.dev/v1/models",
    headers: { Authorization: "Bearer subconscious-key" },
  })
})

test("resolves the native OpenAI provider without treating its SDK as the discovery contract", () => {
  expect(
    FetchModels.resolve({
      providerID: "openai",
      providerNPMs: ["@ai-sdk/openai"],
      authKey: "openai-key",
    }),
  ).toEqual({
    endpoint: "https://api.openai.com/v1/models",
    headers: { Authorization: "Bearer openai-key" },
  })
})

test("preserves discovery for generic OpenAI-compatible providers", () => {
  expect(
    FetchModels.resolve({
      providerID: "custom-gateway",
      providerNPMs: ["@ai-sdk/openai-compatible"],
      configOptions: { baseURL: "https://gateway.example/v1" },
      authKey: "gateway-key",
    }),
  ).toEqual({
    endpoint: "https://gateway.example/v1/models",
    headers: { Authorization: "Bearer gateway-key" },
  })
})

test("does not infer discovery support from an Anthropic inference adapter", () => {
  expect(
    FetchModels.resolve({
      providerID: "custom-anthropic-provider",
      providerNPMs: ["@ai-sdk/anthropic"],
      catalogBaseURL: "https://api.example.com/v1",
    }),
  ).toBeUndefined()
})

test("lets explicit config headers override a provider discovery profile", () => {
  expect(
    FetchModels.resolve({
      providerID: "anthropic",
      providerNPMs: ["@ai-sdk/anthropic"],
      authKey: "ignored-key",
      configOptions: {
        headers: {
          "x-api-key": "configured-key",
          "anthropic-version": "configured-version",
        },
      },
    }),
  ).toEqual({
    endpoint: "https://api.anthropic.com/v1/models",
    headers: {
      "x-api-key": "configured-key",
      "anthropic-version": "configured-version",
    },
  })
})
