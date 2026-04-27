import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const sse = (text: string) => `data: ${JSON.stringify({ result: { content: [{ type: "text", text }] } })}\n\n`

const errorSse = (text: string) =>
  `data: ${JSON.stringify({ result: { isError: true, content: [{ type: "text", text }] } })}\n\n`

describe("McpExa", () => {
  const originalExaApiKey = process.env.EXA_API_KEY

  afterEach(() => {
    if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY
    else process.env.EXA_API_KEY = originalExaApiKey
  })

  test("uses the provided credential snapshot instead of a process env fallback", async () => {
    process.env.EXA_API_KEY = "env-key"
    const McpExa = await import("../../src/tool/mcp-exa")
    const seen: string[] = []
    const http = HttpClient.make((request) => {
      seen.push(request.url)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(sse("ok"), { status: 200 })))
    })

    const output = await Effect.runPromise(
      McpExa.call(
        http,
        "web_search_exa",
        McpExa.SearchArgs,
        {
          query: "pawwork",
          type: "auto",
          numResults: 1,
          livecrawl: "fallback",
        },
        "1 second",
        { source: "saved", key: "submitted-key" },
      ),
    )

    expect(output).toBe("ok")
    expect(new URL(seen[0]).searchParams.get("exaApiKey")).toBe("submitted-key")
  })

  test("treats MCP isError responses as classified failures", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(errorSse("web_search_exa error (401): Invalid API key"), { status: 200 }),
        ),
      ),
    )

    await expect(
      Effect.runPromise(
        McpExa.call(
          http,
          "web_search_exa",
          McpExa.SearchArgs,
          {
            query: "pawwork",
            type: "auto",
            numResults: 1,
            livecrawl: "fallback",
          },
          "1 second",
          { source: "saved", key: "submitted-key" },
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "invalid_key",
        source: "saved",
        status: 401,
      },
    })
  })

  test("carries the saved credential version in classified failures", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(errorSse("web_search_exa error (401): Invalid API key"), { status: 200 }),
        ),
      ),
    )

    await expect(
      Effect.runPromise(
        McpExa.call(
          http,
          "web_search_exa",
          McpExa.SearchArgs,
          {
            query: "pawwork",
            type: "auto",
            numResults: 1,
            livecrawl: "fallback",
          },
          "1 second",
          { source: "saved", key: "submitted-key", version: "saved-version" },
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "invalid_key",
        source: "saved",
        status: 401,
        credentialVersion: "saved-version",
      },
    })
  })

  test("does not classify incidental status text as an HTTP status", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(errorSse("document status 404 was returned"), { status: 200 }),
        ),
      ),
    )

    await expect(
      Effect.runPromise(
        McpExa.call(
          http,
          "web_search_exa",
          McpExa.SearchArgs,
          {
            query: "pawwork",
            type: "auto",
            numResults: 1,
            livecrawl: "fallback",
          },
          "1 second",
          { source: "saved", key: "submitted-key" },
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "unknown",
        source: "saved",
        status: undefined,
      },
    })
  })

  test("fails instead of passing through empty SSE bodies", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
    )

    await expect(
      Effect.runPromise(
        McpExa.call(
          http,
          "web_search_exa",
          McpExa.SearchArgs,
          {
            query: "pawwork",
            type: "auto",
            numResults: 1,
            livecrawl: "fallback",
          },
          "1 second",
          { source: "saved", key: "submitted-key" },
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "unknown",
        source: "saved",
      },
    })
  })

  test("wraps malformed SSE data as a typed failure", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("data: not-json\n\n", { status: 200 }))),
    )

    await expect(
      Effect.runPromise(
        McpExa.call(
          http,
          "web_search_exa",
          McpExa.SearchArgs,
          {
            query: "pawwork",
            type: "auto",
            numResults: 1,
            livecrawl: "fallback",
          },
          "1 second",
          { source: "saved", key: "submitted-key" },
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "unknown",
        source: "saved",
      },
    })
  })

  test("decodes JSON from multiline SSE data fields", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('data: {"result":\ndata: {"content":[{"type":"text","text":"ok"}]}}\n\n', { status: 200 }),
        ),
      ),
    )

    const output = await Effect.runPromise(
      McpExa.call(
        http,
        "web_search_exa",
        McpExa.SearchArgs,
        {
          query: "pawwork",
          type: "auto",
          numResults: 1,
          livecrawl: "fallback",
        },
        "1 second",
        { source: "saved", key: "submitted-key" },
      ),
    )

    expect(output).toBe("ok")
  })

  test("classifies bare HTTP 402 responses as quota exhaustion", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("Payment Required", { status: 402 }))),
    )

    await expect(
      Effect.runPromise(
        McpExa.call(
          http,
          "web_search_exa",
          McpExa.SearchArgs,
          {
            query: "pawwork",
            type: "auto",
            numResults: 1,
            livecrawl: "fallback",
          },
          "1 second",
          { source: "anonymous" },
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "quota_exceeded",
        source: "anonymous",
        status: 402,
      },
    })
  })

  test("unknown failure copy does not ask users to configure a key", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")

    expect(McpExa.messageForFailure({ kind: "unknown", source: "anonymous", status: 500 })).not.toMatch(
      /key|settings|configure/i,
    )
  })

  test("env quota copy does not point at the read-only settings flow", async () => {
    const McpExa = await import("../../src/tool/mcp-exa")

    expect(McpExa.messageForFailure({ kind: "quota_exceeded", source: "env", status: 429 })).toBe(
      "The EXA_API_KEY search quota was reached. Update the environment variable and retry.",
    )
  })
})
