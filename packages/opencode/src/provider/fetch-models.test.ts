import { expect, test } from "bun:test"
import { FetchModels } from "@/provider/fetch-models"

const resolveCompatible = (input: Omit<FetchModels.ResolveInput, "providerID" | "providerNPMs">) =>
  FetchModels.resolve({
    providerID: "custom-gateway",
    providerNPMs: ["@ai-sdk/openai-compatible"],
    ...input,
  })

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
  expect(resolveCompatible({ providerBaseURL: "https://gateway.example/v1" })?.endpoint).toBe(
    "https://gateway.example/v1/models",
  )
  expect(resolveCompatible({ providerBaseURL: "https://gateway.example/v1/" })?.endpoint).toBe(
    "https://gateway.example/v1/models",
  )
  expect(resolveCompatible({ providerBaseURL: "  https://gateway.example/v1//  " })?.endpoint).toBe(
    "https://gateway.example/v1/models",
  )
})

test("resolves base URL precedence as endpoint > baseURL > resolved provider API", () => {
  expect(
    resolveCompatible({
      configOptions: { endpoint: "https://endpoint.example", baseURL: "https://base.example" },
      providerBaseURL: "https://configured.example",
    })?.endpoint,
  ).toBe("https://endpoint.example/models")
  expect(
    resolveCompatible({
      configOptions: { baseURL: "https://base.example" },
      providerBaseURL: "https://configured.example",
    })?.endpoint,
  ).toBe("https://base.example/models")
  expect(resolveCompatible({ providerBaseURL: "https://configured.example" })?.endpoint).toBe(
    "https://configured.example/models",
  )
})

test("returns undefined when no model discovery base URL is known", () => {
  expect(resolveCompatible({})).toBeUndefined()
  expect(resolveCompatible({ configOptions: {} })).toBeUndefined()
})

test("returns undefined for an unresolved or invalid model discovery base URL", () => {
  expect(resolveCompatible({ providerBaseURL: "https://${GATEWAY_HOST}/v1" })).toBeUndefined()
  expect(resolveCompatible({ providerBaseURL: "not a URL" })).toBeUndefined()
})

test("copies string config headers and drops non-string values", () => {
  const result = resolveCompatible({
    providerBaseURL: "https://provider.example",
    configOptions: { headers: { "X-Title": "pawwork", "X-Bad": 5 as unknown as string } },
  })
  expect(result?.headers).toEqual({ "X-Title": "pawwork" })
})

test("adds a Bearer header from the auth key, preferring it over a config apiKey", () => {
  expect(
    resolveCompatible({ providerBaseURL: "https://provider.example", authKey: "auth-key" })?.headers["Authorization"],
  ).toBe("Bearer auth-key")
  expect(
    resolveCompatible({ providerBaseURL: "https://provider.example", configOptions: { apiKey: "config-key" } })
      ?.headers[
      "Authorization"
    ],
  ).toBe("Bearer config-key")
  expect(
    resolveCompatible({
      providerBaseURL: "https://provider.example",
      authKey: "auth-key",
      configOptions: { apiKey: "config-key" },
    })?.headers["Authorization"],
  ).toBe("Bearer auth-key")
})

test("does not overwrite an explicit Authorization header from config", () => {
  const result = resolveCompatible({
    providerBaseURL: "https://provider.example",
    authKey: "auth-key",
    configOptions: { headers: { authorization: "Token preset" } },
  })
  expect(result?.headers).toEqual({ authorization: "Token preset" })
})

test.each([
  [
    "resolves Kimi independently of its Anthropic inference adapter",
    "kimi-for-coding",
    "@ai-sdk/anthropic",
    "https://api.kimi.com/coding/v1",
    "kimi-key",
    "https://api.kimi.com/coding/v1/models",
    { Authorization: "Bearer kimi-key" },
  ],
  [
    "maps MiniMax's global Anthropic endpoint to OpenAI discovery",
    "minimax",
    "@ai-sdk/anthropic",
    "https://api.minimax.io/anthropic/v1",
    "minimax-key",
    "https://api.minimax.io/v1/models",
    { Authorization: "Bearer minimax-key" },
  ],
  [
    "maps the MiniMax global coding plan endpoint",
    "minimax-coding-plan",
    "@ai-sdk/anthropic",
    "https://api.minimax.io/anthropic/v1",
    "minimax-key",
    "https://api.minimax.io/v1/models",
    { Authorization: "Bearer minimax-key" },
  ],
  [
    "maps MiniMax's China endpoint",
    "minimax-cn",
    "@ai-sdk/anthropic",
    "https://api.minimaxi.com/anthropic/v1",
    "minimax-key",
    "https://api.minimaxi.com/v1/models",
    { Authorization: "Bearer minimax-key" },
  ],
  [
    "maps the MiniMax China coding plan endpoint",
    "minimax-cn-coding-plan",
    "@ai-sdk/anthropic",
    "https://api.minimaxi.com/anthropic/v1",
    "minimax-key",
    "https://api.minimaxi.com/v1/models",
    { Authorization: "Bearer minimax-key" },
  ],
  [
    "resolves FreeModel independently of its Anthropic inference adapter",
    "freemodel",
    "@ai-sdk/anthropic",
    "https://cc.freemodel.dev/v1",
    undefined,
    "https://cc.freemodel.dev/v1/models",
    {},
  ],
  [
    "resolves Subconscious independently of its Anthropic inference adapter",
    "subconscious",
    "@ai-sdk/anthropic",
    "https://api.subconscious.dev/v1",
    "subconscious-key",
    "https://api.subconscious.dev/v1/models",
    { Authorization: "Bearer subconscious-key" },
  ],
  [
    "resolves native OpenAI without treating its SDK as the discovery contract",
    "openai",
    "@ai-sdk/openai",
    undefined,
    "openai-key",
    "https://api.openai.com/v1/models",
    { Authorization: "Bearer openai-key" },
  ],
] as const)(
  "%s",
  (_name, providerID, providerNPM, providerBaseURL, authKey, endpoint, headers) => {
    expect(
      FetchModels.resolve({
        providerID,
        providerNPMs: [providerNPM],
        providerBaseURL,
        authKey,
      }),
    ).toEqual({ endpoint, headers })
  },
)

test("keeps MiniMax discovery on its OpenAI endpoint when inference overrides use Anthropic", () => {
  expect(
    FetchModels.resolve({
      providerID: "minimax",
      providerNPMs: ["@ai-sdk/anthropic"],
      providerBaseURL: "https://api.minimax.io/anthropic/v1",
      configOptions: { baseURL: "https://api.minimax.io/anthropic/v1" },
      authKey: "minimax-key",
    }),
  ).toEqual({
    endpoint: "https://api.minimax.io/v1/models",
    headers: { Authorization: "Bearer minimax-key" },
  })
})

test("lets an explicit MiniMax discovery endpoint override the official profile", () => {
  expect(
    FetchModels.resolve({
      providerID: "minimax",
      providerNPMs: ["@ai-sdk/anthropic"],
      providerBaseURL: "https://api.minimax.io/anthropic/v1",
      configOptions: { endpoint: "https://corp-proxy.example/openai/v1" },
      authKey: "proxy-secret",
    }),
  ).toEqual({
    endpoint: "https://corp-proxy.example/openai/v1/models",
    headers: { Authorization: "Bearer proxy-secret" },
  })
})

test("resolves Anthropic discovery with its native base URL and version header", () => {
  expect(
    FetchModels.resolve({
      providerID: "anthropic",
      providerNPMs: ["@ai-sdk/anthropic"],
      authKey: "anthropic-key",
    }),
  ).toEqual({
    endpoint: "https://api.anthropic.com/v1/models?limit=1000",
    headers: {
      "X-Api-Key": "anthropic-key",
      "anthropic-version": "2023-06-01",
    },
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
      providerBaseURL: "https://api.example.com/v1",
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
    endpoint: "https://api.anthropic.com/v1/models?limit=1000",
    headers: {
      "x-api-key": "configured-key",
      "anthropic-version": "configured-version",
    },
  })
})

test("overrides provider profile headers case-insensitively", () => {
  expect(
    FetchModels.resolve({
      providerID: "anthropic",
      providerNPMs: ["@ai-sdk/anthropic"],
      authKey: "anthropic-key",
      configOptions: {
        headers: {
          "Anthropic-Version": "configured-version",
        },
      },
    }),
  ).toEqual({
    endpoint: "https://api.anthropic.com/v1/models?limit=1000",
    headers: {
      "Anthropic-Version": "configured-version",
      "X-Api-Key": "anthropic-key",
    },
  })
})

test("keeps a routing API key while adding Bearer authentication", () => {
  expect(
    FetchModels.resolve({
      providerID: "custom-gateway",
      providerNPMs: ["@ai-sdk/openai-compatible"],
      authKey: "gateway-key",
      configOptions: {
        baseURL: "https://gateway.example/v1",
        headers: {
          "x-api-key": "routing-key",
        },
      },
    }),
  ).toEqual({
    endpoint: "https://gateway.example/v1/models",
    headers: {
      "x-api-key": "routing-key",
      Authorization: "Bearer gateway-key",
    },
  })
})
