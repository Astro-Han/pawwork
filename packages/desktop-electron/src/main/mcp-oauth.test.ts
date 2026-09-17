import { createHash, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import * as mcpClient from "@deepseek-ai/dsh-mcp-client"
import { beforeEach, describe, expect, test } from "vitest"
import { createMcpOAuthEngine, SERVER_STATE } from "../../resources/dsh/mcp-oauth/lib/engine.js"

// Cordis comes from the tree the installed DSH packages themselves use, so the
// context this test drives is the same implementation the bridge runs under. The
// MCP server classes only ever speak to that bridge over HTTP, so their copy is
// irrelevant and the bridge's own dependency is the convenient one to reuse.
const fromDesktop = createRequire(import.meta.url)
const fromDsh = createRequire(fromDesktop.resolve("@deepseek-ai/dsh/package.json"))
const fromMcp = createRequire(fromDesktop.resolve("@deepseek-ai/dsh-mcp-client"))
const { Context } = (await import(fromDsh.resolve("@deepseek-ai/cordis"))) as { Context: new () => any }
const { Server } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/server/index.js"))) as any
const { StreamableHTTPServerTransport } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"))) as any
const { CallToolRequestSchema, ListToolsRequestSchema } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/types.js"))) as any

// The engine is driven end to end here: a fake authorization server plus a fake
// MCP endpoint that refuses until it sees the access token that server issued, the
// real patched mcp-client bridge forked through a real cordis context, and the
// harness credential seam replaced by an in-memory record store.

function memoryCredentials() {
  const records = new Map<string, unknown>()
  return {
    records,
    async readRecord(key: string) {
      return records.get(key)
    },
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return next
    },
    async deleteRecord(key: string) {
      records.delete(key)
    },
  }
}

function base64url(input: Buffer) {
  return input.toString("base64url")
}

interface ProviderHandle {
  mcpUrl: string
  authorizeUrl: string
  close(): Promise<void>
  issues: string[]
  refreshed: number
  /** Refuse every refresh grant, as an authorization server does once a grant is revoked. */
  breakRefresh(): void
  /** Stop accepting the access token handed out so far, as an expiry does. */
  expireAccessToken(): void
  /** Fail every MCP request the way an outage does, without touching the grant. */
  breakMcp(): void
}

async function startProvider(): Promise<ProviderHandle> {
  const issues: string[] = []
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  const clients = new Set<string>()
  let accessToken = ""
  let refreshToken = ""
  let refreshBroken = false
  let mcpBroken = false
  let refreshed = 0
  let port = 0
  const origin = () => "http://127.0.0.1:" + port

  const sessions = new Map<string, any>()
  function mcpServer() {
    const server = new Server({ name: "fake", version: "0.0.1" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request: { params?: { arguments?: { text?: string } } }) => ({
      content: [{ type: "text", text: String(request.params?.arguments?.text ?? "") }],
    }))
    return server
  }

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
  }

  async function handleMcp(request: IncomingMessage, response: ServerResponse) {
    if (mcpBroken) {
      json(response, 500, { jsonrpc: "2.0", error: { code: -32000, message: "upstream is unavailable" }, id: null })
      return
    }
    const authorized = request.headers.authorization === "Bearer " + accessToken && accessToken !== ""
    if (!authorized) {
      response
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="OAuth", resource_metadata="' + origin() + '/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
        })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid access token" }, id: null }))
      return
    }
    const header = request.headers["mcp-session-id"]
    const existing = typeof header === "string" ? sessions.get(header) : undefined
    if (existing !== undefined) {
      await existing.handleRequest(request, response)
      return
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => sessions.set(id, transport),
    } as never)
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
    }
    await mcpServer().connect(transport)
    await transport.handleRequest(request, response)
  }

  async function handleOAuth(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(response, 200, { resource: origin() + "/mcp", authorization_servers: [origin()], scopes_supported: ["default"], bearer_methods_supported: ["header"] })
      return
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer: origin(),
        authorization_endpoint: origin() + "/authorize",
        token_endpoint: origin() + "/token",
        registration_endpoint: origin() + "/register",
        scopes_supported: ["default"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      })
      return
    }
    if (url.pathname === "/register") {
      const clientId = randomUUID()
      clients.add(clientId)
      json(response, 201, { client_id: clientId, redirect_uris: [], token_endpoint_auth_method: "none" })
      return
    }
    if (url.pathname === "/authorize") {
      const state = url.searchParams.get("state") ?? ""
      const redirectUri = url.searchParams.get("redirect_uri") ?? ""
      const challenge = url.searchParams.get("code_challenge") ?? ""
      const code = randomUUID()
      codes.set(code, { challenge, redirectUri })
      const target = new URL(redirectUri)
      target.searchParams.set("code", code)
      target.searchParams.set("state", state)
      response.writeHead(302, { location: target.toString() }).end()
      return
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request))
      if (body.get("grant_type") === "refresh_token") {
        if (refreshBroken) {
          issues.push("invalid_grant")
          json(response, 400, { error: "invalid_grant" })
          return
        }
        refreshed += 1
        accessToken = "access-" + randomUUID()
        json(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken })
        return
      }
      const code = body.get("code") ?? ""
      const held = codes.get(code)
      if (held === undefined) {
        json(response, 400, { error: "invalid_grant" })
        return
      }
      const verifier = body.get("code_verifier") ?? ""
      const digest = base64url(createHash("sha256").update(verifier).digest())
      if (digest !== held.challenge) {
        issues.push("pkce_mismatch")
        json(response, 400, { error: "invalid_grant", error_description: "code_verifier does not match code_challenge" })
        return
      }
      codes.delete(code)
      accessToken = "access-" + randomUUID()
      refreshToken = "refresh-" + randomUUID()
      json(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken })
      return
    }
    response.writeHead(404).end()
  }

  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    void (async () => {
      if (url.pathname === "/mcp") await handleMcp(request, response)
      else await handleOAuth(request, response, url)
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  port = address.port

  return {
    mcpUrl: origin() + "/mcp",
    authorizeUrl: origin() + "/authorize",
    issues,
    get refreshed() {
      return refreshed
    },
    breakRefresh: () => {
      refreshBroken = true
    },
    expireAccessToken: () => {
      accessToken = ""
    },
    breakMcp: () => {
      mcpBroken = true
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  } as ProviderHandle
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/** Follow the authorization URL the way a browser would, without leaving the test. */
async function completeInBrowser(authorizationUrl: string, options: { deny?: boolean; state?: string } = {}) {
  const authorize = await fetch(authorizationUrl, { redirect: "manual" })
  const location = authorize.headers.get("location")
  if (location === null) throw new Error("authorization server did not redirect")
  const redirect = new URL(location)
  if (options.state !== undefined) redirect.searchParams.set("state", options.state)
  if (options.deny === true) {
    redirect.searchParams.delete("code")
    redirect.searchParams.set("error", "access_denied")
  }
  return await fetch(redirect, { redirect: "manual" })
}

function toolsStub() {
  const live = new Map<string, number>()
  return {
    live: () => [...live.keys()].sort(),
    register(definition: { name: string }) {
      live.set(definition.name, (live.get(definition.name) ?? 0) + 1)
      return () => {
        const left = (live.get(definition.name) ?? 1) - 1
        if (left <= 0) live.delete(definition.name)
        else live.set(definition.name, left)
      }
    },
  }
}

function makeContext() {
  const ctx = new Context()
  const tools = toolsStub()
  ctx.provide("tools", tools)
  ctx.provide("logger", { info: () => {}, warn: () => {}, error: () => {} })
  return { ctx, tools }
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

describe("remote MCP OAuth", () => {
  let provider: ProviderHandle
  beforeEach(async () => {
    provider = await startProvider()
    return async () => {
      await provider.close()
    }
  })

  test("first authorization: 401 leads to a browser, tokens land in a grant record, tools register", async () => {
    const credentials = memoryCredentials()
    const { ctx, tools } = makeContext()
    const engine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    ctx.provide("mcpAuth", { providerFor: (config: unknown) => engine.providerFor(config) })

    expect(await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])).toEqual([
      { serverName: "alpha", url: provider.mcpUrl, state: SERVER_STATE.UNAUTHORIZED, authorizationUrl: undefined, lastError: undefined },
    ])

    const { authorizationUrl, completion } = await engine.authorize("alpha")
    expect(authorizationUrl).toContain("/authorize?")
    expect(tools.live()).toEqual([])

    const answer = await completeInBrowser(authorizationUrl)
    expect(answer.status).toBe(200)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    expect(tools.live()).toEqual(["mcp__alpha__echo"])
    expect(engine.status()[0]?.state).toBe(SERVER_STATE.CONNECTED)

    const stored = [...credentials.records.values()] as Array<{ kind: string; payload: Record<string, unknown> }>
    expect(stored).toHaveLength(1)
    expect(stored[0]?.kind).toBe("grant")
    expect((stored[0]?.payload.tokens as { access_token: string }).access_token).toMatch(/^access-/)
    await engine.dispose()
  })

  test("a redirect whose state does not match is refused and leaves the server unauthorized", async () => {
    const credentials = memoryCredentials()
    const { ctx, tools } = makeContext()
    const engine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    ctx.provide("mcpAuth", { providerFor: (config: unknown) => engine.providerFor(config) })
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])

    const { authorizationUrl, completion } = await engine.authorize("alpha")
    const answer = await completeInBrowser(authorizationUrl, { state: "forged" })
    expect(answer.status).toBe(400)
    expect(await completion).toEqual({ state: SERVER_STATE.UNAUTHORIZED, error: "state_mismatch" })
    expect(tools.live()).toEqual([])
    // A refused callback may still have left a client registration behind; what
    // must not exist is a grant.
    for (const record of credentials.records.values() as Iterable<{ payload: Record<string, unknown> }>) {
      expect(record.payload.tokens).toBeUndefined()
    }
    await engine.dispose()
  })

  test("a denied authorization leaves the server unauthorized", async () => {
    const credentials = memoryCredentials()
    const { ctx, tools } = makeContext()
    const engine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    ctx.provide("mcpAuth", { providerFor: (config: unknown) => engine.providerFor(config) })
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])

    const { authorizationUrl, completion } = await engine.authorize("alpha")
    const answer = await completeInBrowser(authorizationUrl, { deny: true })
    expect(answer.status).toBe(200)
    expect(await completion).toEqual({ state: SERVER_STATE.UNAUTHORIZED, error: "access_denied" })
    expect(tools.live()).toEqual([])
    await engine.dispose()
  })

  async function authorizeOnce() {
    const credentials = memoryCredentials()
    const { ctx, tools } = makeContext()
    const engine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    ctx.provide("mcpAuth", { providerFor: (config: unknown) => engine.providerFor(config) })
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    const { authorizationUrl, completion } = await engine.authorize("alpha")
    await completeInBrowser(authorizationUrl)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    return { credentials, engine, tools }
  }

  function grant(credentials: ReturnType<typeof memoryCredentials>) {
    return [...credentials.records.values()] as Array<{ kind: string; payload: Record<string, unknown> }>
  }

  test("an expired access token is refreshed on the next connection", async () => {
    const { credentials, engine } = await authorizeOnce()
    await engine.dispose()
    provider.expireAccessToken()
    expect(grant(credentials)[0]?.payload.tokens).toBeDefined()

    const second = makeContext()
    const secondEngine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => second.ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    second.ctx.provide("mcpAuth", { providerFor: (config: unknown) => secondEngine.providerFor(config) })
    const status = await secondEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(provider.refreshed).toBe(1)
    expect(status[0]?.state).toBe(SERVER_STATE.CONNECTED)
    await settle()
    expect(second.tools.live()).toEqual(["mcp__alpha__echo"])
    await secondEngine.dispose()
  })

  test("a refresh the authorization server refuses drops the grant and reads as expired", async () => {
    const { credentials, engine } = await authorizeOnce()
    await engine.dispose()
    provider.expireAccessToken()
    provider.breakRefresh()

    const second = makeContext()
    const secondEngine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => second.ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    second.ctx.provide("mcpAuth", { providerFor: (config: unknown) => secondEngine.providerFor(config) })
    const status = await secondEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(status[0]?.state).toBe(SERVER_STATE.EXPIRED)
    expect(grant(credentials)[0]?.payload.tokens).toBeUndefined()
    expect(second.tools.live()).toEqual([])
    await secondEngine.dispose()
  })

  test("an unreachable server is reported as itself, never as an expired authorization", async () => {
    const { credentials, engine, tools } = await authorizeOnce()
    const status = await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(status[0]?.state).toBe(SERVER_STATE.CONNECTED)
    provider.breakMcp()
    const after = await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(after[0]?.state).not.toBe(SERVER_STATE.EXPIRED)
    expect(after[0]?.lastError).toBeDefined()
    expect(tools.live()).toEqual([])
    expect(grant(credentials)[0]?.payload.tokens).toBeDefined()
    await engine.dispose()
  })

  test("a stored grant survives a restart and connects without another authorization", async () => {
    const credentials = memoryCredentials()
    const first = makeContext()
    const firstEngine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => first.ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    first.ctx.provide("mcpAuth", { providerFor: (config: unknown) => firstEngine.providerFor(config) })
    await firstEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    const { authorizationUrl, completion } = await firstEngine.authorize("alpha")
    await completeInBrowser(authorizationUrl)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    await firstEngine.dispose()

    const second = makeContext()
    const secondEngine = createMcpOAuthEngine({
      credentials,
      fork: (config: unknown) => second.ctx.plugin(mcpClient as never, config as never),
      sdk: { auth: mcpClient.auth },
    })
    second.ctx.provide("mcpAuth", { providerFor: (config: unknown) => secondEngine.providerFor(config) })
    const status = await secondEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(status[0]?.state).toBe(SERVER_STATE.CONNECTED)
    await settle()
    expect(second.tools.live()).toEqual(["mcp__alpha__echo"])
    expect(provider.refreshed).toBe(0)
    await secondEngine.dispose()
  })
})
