import { describe, expect, test } from "bun:test"
import { createClient } from "../src/v2/gen/client/client.gen.js"
import type { ResolvedRequestOptions } from "../src/v2/gen/client/types.gen.js"
import { createOpencodeClient, wrapClientError } from "../src/v2/client.js"

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

const throwOpts = { throwOnError: true }

describe("wrapClientError", () => {
  test("extracts data.message from a NamedError-shaped body on the throw path", () => {
    const body = { data: { message: "session is locked" }, name: "LockedError" }
    const wrapped = wrapClientError(body, new Response(null, { status: 423 }), undefined, throwOpts)
    expect(wrapped).toBeInstanceOf(Error)
    expect((wrapped as Error).message).toBe("session is locked")
    expect((wrapped as Error).cause).toEqual({ body, status: 423 })
  })

  test("falls back to message, then name, then a request description", () => {
    expect((wrapClientError({ message: "direct" }, undefined, undefined, throwOpts) as Error).message).toBe("direct")
    expect((wrapClientError({ name: "OnlyName" }, undefined, undefined, throwOpts) as Error).message).toBe("OnlyName")

    const request = new Request("https://example.test/x", { method: "POST" })
    const response = new Response(null, { status: 418, statusText: "Teapot" })
    const wrapped = wrapClientError({ unrelated: true }, response, request, throwOpts) as Error
    expect(wrapped.message).toBe("POST https://example.test/x -> 418 Teapot")
  })

  test("wraps a non-empty string body on the throw path", () => {
    const wrapped = wrapClientError("plain failure", undefined, undefined, throwOpts) as Error
    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped.message).toBe("plain failure")
    expect(wrapped.cause).toEqual({ body: "plain failure", status: undefined })
  })

  test("passes a non-empty body through unchanged on the result-tuple path", () => {
    const body = { data: { message: "keep raw" }, name: "Whatever" }
    expect(wrapClientError(body, new Response(null, { status: 500 }), undefined, undefined)).toBe(body)
    expect(wrapClientError("raw string", undefined, undefined, { throwOnError: false })).toBe("raw string")
  })

  test("returns existing Error instances unchanged", () => {
    const original = new Error("already an error")
    expect(wrapClientError(original, undefined, undefined, throwOpts)).toBe(original)
  })

  test("wraps empty bodies with a descriptive message regardless of throwOnError", () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    const request = new Request("https://example.test/y", { method: "GET" })
    for (const opts of [throwOpts, undefined]) {
      const wrapped = wrapClientError({}, response, request, opts) as Error
      expect(wrapped).toBeInstanceOf(Error)
      expect(wrapped.message).toBe("opencode server GET https://example.test/y -> 502 Bad Gateway: (empty response body)")
    }
  })

  test("describes a missing response as a network error", () => {
    const request = new Request("https://example.test/z", { method: "GET" })
    const wrapped = wrapClientError(undefined, undefined, request, throwOpts) as Error
    expect(wrapped.message).toBe("opencode server GET https://example.test/z: network error (no response)")
  })
})

describe("createOpencodeClient error wrapping", () => {
  test("throws a real Error with the extracted message for a structured body", async () => {
    const client = createOpencodeClient({
      baseUrl: "https://example.test",
      fetch: async () => jsonResponse({ data: { message: "session is locked" } }, { status: 423 }),
    })
    const error = await client.global.health({ throwOnError: true }).catch((err) => err)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("session is locked")
    expect(error.cause?.status).toBe(423)
  })

  test("leaves the raw parsed body on the result-tuple path", async () => {
    const body = { data: { message: "nope" }, name: "LockedError" }
    const client = createOpencodeClient({
      baseUrl: "https://example.test",
      fetch: async () => jsonResponse(body, { status: 423 }),
    })
    const result = await client.global.health()
    expect(result.error).toEqual(body)
  })

  test("wraps an empty error body with a descriptive message", async () => {
    const client = createOpencodeClient({
      baseUrl: "https://example.test",
      fetch: async () => new Response("", { status: 500, statusText: "Internal Server Error" }),
    })
    const error = await client.global.health({ throwOnError: true }).catch((err) => err)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain("(empty response body)")
    expect(error.message).toContain("500")
  })
})

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}
