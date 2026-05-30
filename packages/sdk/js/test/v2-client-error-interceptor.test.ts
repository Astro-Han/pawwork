import { expect, test } from "bun:test"
import { createClient } from "../src/v2/gen/client/client.gen.js"
import type { ResolvedRequestOptions } from "../src/v2/gen/client/types.gen.js"

function createInstrumentedClient(fetch: typeof globalThis.fetch) {
  const client = createClient({
    baseUrl: "https://example.test/api",
    credentials: "include",
    fetch,
    headers: {
      "x-default": "from-config",
    },
  })
  const seen: ResolvedRequestOptions[] = []
  client.interceptors.error.use((error, _response, _request, options) => {
    seen.push(options)
    return error
  })
  return { client, seen }
}

function expectResolvedOptions(options: ResolvedRequestOptions | undefined) {
  expect(options).toBeDefined()
  expect(options?.baseUrl).toBe("https://example.test/api")
  expect(options?.credentials).toBe("include")
  expect(options?.headers).toBeInstanceOf(Headers)
  expect(options?.headers.get("x-default")).toBe("from-config")
  expect(options?.headers.get("x-request")).toBe("from-request")
}

test("error interceptor receives resolved options for HTTP errors", async () => {
  const { client, seen } = createInstrumentedClient(async () => {
    return new Response(JSON.stringify({ message: "failed" }), {
      headers: { "content-type": "application/json" },
      status: 500,
    })
  })

  await client.request({
    headers: { "x-request": "from-request" },
    method: "GET",
    url: "/failure",
  })

  expectResolvedOptions(seen[0])
})

test("error interceptor receives resolved options for fetch errors", async () => {
  const { client, seen } = createInstrumentedClient(async () => {
    throw new Error("network down")
  })

  await client.request({
    headers: { "x-request": "from-request" },
    method: "GET",
    url: "/network",
  })

  expectResolvedOptions(seen[0])
})

test("error interceptor receives resolved options for request validator errors", async () => {
  const { client, seen } = createInstrumentedClient(async () => {
    throw new Error("fetch should not run")
  })

  await client.request({
    headers: { "x-request": "from-request" },
    method: "GET",
    requestValidator: async () => {
      throw new Error("invalid request")
    },
    url: "/invalid",
  })

  expectResolvedOptions(seen[0])
})
