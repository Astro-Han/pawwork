import { expect, test } from "bun:test"
import { FetchModels } from "@/provider/fetch-models"

test("parses OpenAI-compatible { data: [...] } shape", () => {
  expect(FetchModels.parse({ data: [{ id: "a" }, { id: "b", name: "Model B" }] })).toEqual([
    { id: "a", name: "a" },
    { id: "b", name: "Model B" },
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
