import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as mcpClient from "@deepseek-ai/dsh-mcp-client"
import { LocalCredentialProvider, parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local"
import { beforeEach, describe, expect, test } from "vitest"
import { createMcpOAuthEngine, SERVER_STATE } from "../../resources/dsh/mcp-oauth/lib/engine.js"
import { createMcpOAuthRpcHandler } from "../../resources/dsh/mcp-oauth/lib/rpc.js"
import { createServerList } from "../../resources/dsh/mcp-oauth/lib/server-list.js"
import { createGrantStore } from "../../resources/dsh/mcp-oauth/lib/grant-store.js"

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
// real file-backed credential provider. The authorization server lives on a
// different origin than the MCP endpoint on purpose: that is what proves
// configured headers never leave the MCP origin.

function fileCredentials(path = join(mkdtempSync(join(tmpdir(), "pawwork-oauth-grants-")), ".credentials.yaml")) {
  const ctx = new Context()
  const ready = Promise.resolve(ctx.plugin(LocalCredentialProvider, { path, watch: false }))
  return {
    path,
    get records() {
      return parseCredentialsDocument(existsSync(path) ? readFileSync(path, "utf8") : "", path).records
    },
    async readRecord(key: string) { await ready; return ctx.credentials.readRecord(key) },
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) { await ready; return ctx.credentials.modifyRecord(key, mutate) },
    async deleteRecord(key: string) { await ready; return ctx.credentials.deleteRecord(key) },
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
  unbreakMcp(): void
  /** The value of one custom request header on every MCP request seen so far. */
  headerValues(): string[]
  /** Authorization headers on MCP requests, to prove whose credential wins. */
  mcpAuthorizations(): string[]
  /** Custom-header values the authorization server saw; must stay empty. */
  asHeaderValues(): string[]
  holdTokenExchange(): { received: Promise<void>; release(): void }
}

async function startProvider(): Promise<ProviderHandle> {
  const issues: string[] = []
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  const clients = new Map<string, string[]>()
  let accessToken = ""
  let refreshToken = ""
  let grantClientId = ""
  let refreshBroken = false
  let mcpBroken = false
  let refreshed = 0
  const seenHeaders: string[] = []
  const seenAuthorizations: string[] = []
  const asSeenHeaders: string[] = []
  let tokenGate: { received(): void; wait: Promise<void> } | undefined
  let mcpPort = 0
  let asPort = 0
  const mcpOrigin = () => "http://127.0.0.1:" + mcpPort
  const asOrigin = () => "http://127.0.0.1:" + asPort

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
    seenHeaders.push(String(request.headers["x-static-header"] ?? ""))
    seenAuthorizations.push(String(request.headers.authorization ?? ""))
    const authorized = request.headers.authorization === "Bearer " + accessToken && accessToken !== ""
    if (!authorized) {
      response
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="OAuth", resource_metadata="' + mcpOrigin() + '/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
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
      json(response, 200, { resource: mcpOrigin() + "/mcp", authorization_servers: [asOrigin()], scopes_supported: ["default"], bearer_methods_supported: ["header"] })
      return
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer: asOrigin(),
        authorization_endpoint: asOrigin() + "/authorize",
        token_endpoint: asOrigin() + "/token",
        registration_endpoint: asOrigin() + "/register",
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
      const metadata = JSON.parse(await readBody(request)) as { redirect_uris: string[] }
      clients.set(clientId, metadata.redirect_uris)
      json(response, 201, { client_id: clientId, redirect_uris: metadata.redirect_uris, token_endpoint_auth_method: "none" })
      return
    }
    if (url.pathname === "/authorize") {
      const state = url.searchParams.get("state") ?? ""
      const redirectUri = url.searchParams.get("redirect_uri") ?? ""
      const challenge = url.searchParams.get("code_challenge") ?? ""
      const clientId = url.searchParams.get("client_id") ?? ""
      if (!clients.get(clientId)?.includes(redirectUri)) {
        json(response, 400, { error: "invalid_request" })
        return
      }
      const code = randomUUID()
      codes.set(code, { challenge, redirectUri, clientId })
      const target = new URL(redirectUri)
      target.searchParams.set("code", code)
      target.searchParams.set("state", state)
      response.writeHead(302, { location: target.toString() }).end()
      return
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request))
      if (body.get("grant_type") === "refresh_token") {
        if (refreshBroken || body.get("refresh_token") !== refreshToken || body.get("client_id") !== grantClientId) {
          issues.push("invalid_grant")
          json(response, 400, { error: "invalid_grant" })
          return
        }
        refreshed += 1
        if (tokenGate) {
          tokenGate.received()
          await tokenGate.wait
        }
        accessToken = "access-" + randomUUID()
        json(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken })
        return
      }
      const code = body.get("code") ?? ""
      const held = codes.get(code)
      if (held === undefined || body.get("client_id") !== held.clientId || body.get("redirect_uri") !== held.redirectUri) {
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
      if (tokenGate) {
        tokenGate.received()
        await tokenGate.wait
      }
      accessToken = "access-" + randomUUID()
      refreshToken = "refresh-" + randomUUID()
      grantClientId = held.clientId
      json(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken })
      return
    }
    response.writeHead(404).end()
  }

  // The resource metadata stays on the MCP origin (RFC 9728 names it from the
  // resource); everything else belongs to the separate authorization-server
  // origin so cross-origin header bleed is observable.
  const mcpHttp = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    void (async () => {
      if (url.pathname === "/mcp") await handleMcp(request, response)
      else await handleOAuth(request, response, url)
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
  const asHttp = createServer((request, response) => {
    asSeenHeaders.push(String(request.headers["x-static-header"] ?? ""))
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    void handleOAuth(request, response, url).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => mcpHttp.listen(0, "127.0.0.1", resolve))
  await new Promise<void>((resolve) => asHttp.listen(0, "127.0.0.1", resolve))
  const mcpAddress = mcpHttp.address()
  const asAddress = asHttp.address()
  if (mcpAddress === null || typeof mcpAddress === "string" || asAddress === null || typeof asAddress === "string") throw new Error("no port")
  mcpPort = mcpAddress.port
  asPort = asAddress.port

  return {
    mcpUrl: mcpOrigin() + "/mcp",
    authorizeUrl: asOrigin() + "/authorize",
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
    unbreakMcp: () => {
      mcpBroken = false
    },
    headerValues: () => seenHeaders.slice(),
    mcpAuthorizations: () => seenAuthorizations.slice(),
    asHeaderValues: () => asSeenHeaders.slice(),
    holdTokenExchange() {
      let received!: () => void
      let release!: () => void
      const arrived = new Promise<void>((resolve) => { received = resolve })
      const wait = new Promise<void>((resolve) => { release = resolve })
      tokenGate = { received, wait }
      return { received: arrived, release }
    },
    close: async () => {
      // Keep-alive sockets (the client's session stream included) would
      // otherwise keep `close` waiting long past the test's own teardown.
      mcpHttp.closeAllConnections?.()
      asHttp.closeAllConnections?.()
      await Promise.all([
        new Promise<void>((resolve) => mcpHttp.close(() => resolve())),
        new Promise<void>((resolve) => asHttp.close(() => resolve())),
      ])
    },
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
  const definitions = new Map<string, any>()
  return {
    live: () => [...live.keys()].sort(),
    call: (name: string, args: unknown) => definitions.get(name).execute(args, { signal: new AbortController().signal }),
    register(definition: { name: string }) {
      definitions.set(definition.name, definition)
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

function tempList() {
  return createServerList(join(mkdtempSync(join(tmpdir(), "pawwork-oauth-list-")), "mcp-oauth.json"))
}

function makeEngine(ctx: any, credentials: ReturnType<typeof fileCredentials>, list = tempList()) {
  const engine = createMcpOAuthEngine({
    credentials,
    list,
    fork: (config: unknown) => ctx.plugin(mcpClient as never, config as never),
    sdk: { auth: mcpClient.auth },
  })
  ctx.provide("mcpAuth", { providerFor: (config: unknown) => engine.providerFor(config) })
  return engine
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

  test("the bridge exports the UnauthorizedError thrown by its ESM transport", async () => {
    const { StreamableHTTPClientTransport } = await import(fromMcp.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js").replace("/dist/cjs/", "/dist/esm/"))
    const transport = new StreamableHTTPClientTransport(new URL(provider.mcpUrl))
    await transport.start()
    try {
      await expect(transport.finishAuth("unused")).rejects.toBeInstanceOf(mcpClient.UnauthorizedError)
    } finally {
      await transport.close()
    }
  })

  test("a failed fork releases the server name for a retry", async () => {
    const { ctx } = makeContext()
    const config = { transport: "streamable-http", serverName: "probe-x", url: "http://127.0.0.1:1/mcp", failOnStartupError: true }
    const first = ctx.plugin(mcpClient, config)
    await expect(first).rejects.toThrow(/initial connection/)
    // If the namespace reservation had survived the failed apply, this fork
    // would report the name as taken instead of failing on the server itself.
    const second = ctx.plugin(mcpClient, config)
    await expect(second).rejects.toThrow(/initial connection/)
    await first.dispose?.().catch(() => {})
    await second.dispose?.().catch(() => {})
  })

  test("disposing during configuration cannot revive the engine", async () => {
    const engine = createMcpOAuthEngine({ credentials: fileCredentials(), list: tempList(), fork: async () => { throw new Error("unexpected fork") }, sdk: { auth: mcpClient.auth } })
    const configuring = engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await engine.dispose()
    await configuring
    expect(engine.providerFor({ serverName: "alpha", url: provider.mcpUrl, transport: "streamable-http" })).toBeUndefined()
    expect(() => engine.authorize("alpha")).toThrow(/no remote MCP server/)
  })

  test("an authorize queued behind a slow startup load produces a single run", async () => {
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    // Hold the grant read so the authorize lands while load is still in flight:
    // the lane must make them sequential rather than letting two runs coexist.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gated = {
      ...credentials,
      async readRecord(key: string) { await gate; return credentials.readRecord(key) },
    }
    const engine = createMcpOAuthEngine({ credentials: gated, list: tempList(), fork: (config: unknown) => ctx.plugin(mcpClient as never, config as never), sdk: { auth: mcpClient.auth } })
    ctx.provide("mcpAuth", { providerFor: (config: unknown) => engine.providerFor(config) })
    const configuring = engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    const authorizing = engine.authorize("alpha")
    release()
    await configuring
    const started = await authorizing
    expect(started.authorizationUrl).toContain("/authorize?")
    await completeInBrowser(started.authorizationUrl)
    expect(await started.completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    expect(tools.live()).toEqual(["mcp__alpha__echo"])
    // The teardown that matters: exactly one fork existed, so removing the
    // server leaves nothing behind — no orphaned second run's tools or grant.
    await engine.remove("alpha")
    expect(tools.live()).toEqual([])
    expect(credentials.records.size).toBe(0)
    await engine.dispose()
  })

  test("one unreadable grant does not hide subsequent servers or prevent removal", async () => {
    const credentials = fileCredentials()
    const engine = createMcpOAuthEngine({
      credentials: { ...credentials, async readRecord(key: string) { if (key === createGrantStore(credentials, { serverName: "alpha", serverUrl: provider.mcpUrl }).key) throw new Error("record unavailable"); return credentials.readRecord(key) } },
      list: tempList(),
      fork: async () => { throw new Error("unexpected fork") },
      sdk: { auth: mcpClient.auth },
    })
    const status = await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }, { serverName: "beta", url: provider.mcpUrl }])
    expect(status.servers.map((server: { state: string }) => server.state)).toEqual([SERVER_STATE.DISCONNECTED, SERVER_STATE.DISCONNECTED])
    expect(engine.providerFor({ serverName: "beta", url: "https://other.example/mcp", transport: "streamable-http" })).toBeUndefined()
    expect((await engine.remove("alpha")).servers).toHaveLength(1)
    expect((await engine.remove("alpha")).servers).toHaveLength(1)
    await engine.dispose()
  })

  test.each(["signOut", "remove", "dispose"] as const)("%s cancels an in-flight token exchange without restoring credentials or tools", async (operation) => {
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    const engine = makeEngine(ctx, credentials)
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    const gate = provider.holdTokenExchange()
    const started = await engine.authorize("alpha")
    await completeInBrowser(started.authorizationUrl)
    await gate.received
    await engine[operation]("alpha")
    gate.release()
    await Promise.resolve(started.completion).catch(() => {})
    try {
      expect(tools.live()).toEqual([])
      expect([...credentials.records.values()].some((record: any) => record.payload?.tokens !== undefined)).toBe(false)
      if (operation !== "dispose") expect(credentials.records.size).toBe(0)
    } finally {
      await engine.dispose()
    }
  })

  test("first authorization: 401 leads to a browser, tokens land in a grant record, tools register", async () => {
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    const engine = makeEngine(ctx, credentials)

    // A server with no grant at all gets one probe: the 401 it answers starts
    // the authorization flow instead of staying an unexplained failure.
    const configured = await engine.configure([{ serverName: "alpha", url: provider.mcpUrl, headers: { "x-static-header": "kept", authorization: "Bearer static-key" } }])
    await settle()
    expect(configured.servers[0]?.state).toBe(SERVER_STATE.UNAUTHORIZED)

    const { authorizationUrl, completion } = await engine.authorize("alpha")
    expect(authorizationUrl).toContain("/authorize?")
    expect(tools.live()).toEqual([])

    const answer = await completeInBrowser(authorizationUrl)
    expect(answer.status).toBe(200)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    expect(tools.live()).toEqual(["mcp__alpha__echo"])
    expect(await tools.call("mcp__alpha__echo", { text: "verified through MCP" })).toEqual({ content: [{ type: "text", text: "verified through MCP" }] })
    expect(engine.status().servers[0]?.state).toBe(SERVER_STATE.CONNECTED)

    const stored = [...credentials.records.values()] as Array<{ kind: string; payload: Record<string, unknown> }>
    expect(stored).toHaveLength(1)
    expect(stored[0]?.kind).toBe("grant")
    expect((stored[0]?.payload.tokens as { access_token: string }).access_token).toMatch(/^access-/)

    // The static header reaches the MCP origin but never the authorization
    // server on the other origin — not even during discovery or the exchange.
    expect(provider.headerValues()).toContain("kept")
    expect(provider.asHeaderValues().length).toBeGreaterThan(0)
    expect(provider.asHeaderValues().every((value) => value === "")).toBe(true)
    // A configured Authorization header must not displace the OAuth Bearer:
    // the probe before tokens existed may carry it, every post-grant request
    // carries the token the authorization server issued.
    expect(provider.mcpAuthorizations().filter(Boolean).at(-1)).toMatch(/^Bearer access-/)
    expect(provider.mcpAuthorizations().filter((value) => value.startsWith("Bearer access-")).length).toBeGreaterThan(0)
    await engine.dispose()
  })

  test("a duplicate authorize during a pending attempt reuses it", async () => {
    const credentials = fileCredentials()
    const { ctx } = makeContext()
    const engine = makeEngine(ctx, credentials)
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await settle()
    const [again, duplicate] = await Promise.all([engine.authorize("alpha"), engine.authorize("alpha")])
    expect(duplicate.authorizationUrl).toBe(again.authorizationUrl)
    expect(engine.status().servers[0]?.authorizationPending).toBe(true)
    await completeInBrowser(again.authorizationUrl)
    expect(await again.completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await engine.dispose()
  })

  test("authorizing a connected server is refused rather than destroying the grant", async () => {
    const credentials = fileCredentials()
    const { ctx } = makeContext()
    const engine = makeEngine(ctx, credentials)
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await settle()
    const { authorizationUrl, completion } = await engine.authorize("alpha")
    await completeInBrowser(authorizationUrl)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await expect(engine.authorize("alpha")).rejects.toThrow(/sign out/)
    expect([...credentials.records.values()][0] as any).toMatchObject({ kind: "grant" })
    await engine.dispose()
  })

  test("unmatched success and error callbacks cannot consume the pending authorization", async () => {
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    const engine = makeEngine(ctx, credentials)
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await settle()

    const { authorizationUrl, completion } = await engine.authorize("alpha")
    const answer = await completeInBrowser(authorizationUrl, { state: "forged" })
    expect(answer.status).toBe(400)
    const denied = await completeInBrowser(authorizationUrl, { state: "forged", deny: true })
    expect(denied.status).toBe(400)
    expect(tools.live()).toEqual([])
    // A refused callback may still have left a client registration behind; what
    // must not exist is a grant.
    for (const record of credentials.records.values() as Iterable<{ payload: Record<string, unknown> }>) {
      expect(record.payload.tokens).toBeUndefined()
    }
    expect((await completeInBrowser(authorizationUrl)).status).toBe(200)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await engine.dispose()
  })

  test("a denied authorization leaves the server unauthorized", async () => {
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    const engine = makeEngine(ctx, credentials)
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await settle()

    const { authorizationUrl, completion } = await engine.authorize("alpha")
    const answer = await completeInBrowser(authorizationUrl, { deny: true })
    expect(answer.status).toBe(200)
    expect(await completion).toEqual({ state: SERVER_STATE.UNAUTHORIZED, error: "access_denied" })
    expect(tools.live()).toEqual([])
    await engine.dispose()
  })

  async function authorizeOnce(headers?: Record<string, string>) {
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    const engine = makeEngine(ctx, credentials)
    await engine.configure([{ serverName: "alpha", url: provider.mcpUrl, headers }])
    await settle()
    const { authorizationUrl, completion } = await engine.authorize("alpha")
    await completeInBrowser(authorizationUrl)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    return { credentials, engine, tools }
  }

  test("a transport refresh finishing after sign-out cannot restore a grant", async () => {
    const { credentials, engine, tools } = await authorizeOnce()
    provider.expireAccessToken()
    const gate = provider.holdTokenExchange()
    const calling = tools.call("mcp__alpha__echo", { text: "refresh" }).catch(() => {})
    await gate.received
    await engine.signOut("alpha")
    gate.release()
    await calling
    expect(credentials.records.size).toBe(0)
    expect(tools.live()).toEqual([])
    expect(engine.status().servers[0]?.state).toBe(SERVER_STATE.UNAUTHORIZED)
    await engine.dispose()
  })

  function grant(credentials: ReturnType<typeof fileCredentials>) {
    return [...credentials.records.values()] as Array<{ kind: string; payload: Record<string, unknown> }>
  }

  test("an expired access token is refreshed on the next connection", async () => {
    const { credentials, engine } = await authorizeOnce()
    await engine.dispose()
    provider.expireAccessToken()
    expect(grant(credentials)[0]?.payload.tokens).toBeDefined()

    const second = makeContext()
    const secondEngine = makeEngine(second.ctx, credentials)
    const status = await secondEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(provider.refreshed).toBe(1)
    expect(status.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
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
    const secondEngine = makeEngine(second.ctx, credentials)
    const status = await secondEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await settle()
    expect(status.servers[0]?.state).toBe(SERVER_STATE.EXPIRED)
    expect(grant(credentials)[0]?.payload.tokens).toBeUndefined()
    expect(second.tools.live()).toEqual([])
    await secondEngine.dispose()
  })

  test("an unreachable server keeps its grant and is retried, not marked expired", async () => {
    const { credentials, engine, tools } = await authorizeOnce()
    const status = await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(status.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
    provider.breakMcp()
    // The startup path does not fail fast: the bridge keeps the grant and
    // retries in the background instead of declaring the server dead.
    const after = await engine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(after.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
    expect(grant(credentials)[0]?.payload.tokens).toBeDefined()
    await engine.dispose()
    expect(tools.live()).toEqual([])
  })

  test("retry gives an honest answer and reconnects without touching the grant", async () => {
    const { credentials, engine } = await authorizeOnce()
    provider.breakMcp()
    const failed = await engine.retry("alpha")
    expect(failed.servers[0]?.state).toBe(SERVER_STATE.DISCONNECTED)
    expect(failed.servers[0]?.lastError).toBeDefined()
    expect(grant(credentials)[0]?.payload.tokens).toBeDefined()
    provider.unbreakMcp()
    const recovered = await engine.retry("alpha")
    expect(recovered.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
    expect(grant(credentials)[0]?.payload.tokens).toBeDefined()
    await engine.dispose()
  })

  test("a stored grant survives a restart and connects without another authorization", async () => {
    const credentials = fileCredentials()
    const first = makeContext()
    const firstEngine = makeEngine(first.ctx, credentials)
    await firstEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    await settle()
    const { authorizationUrl, completion } = await firstEngine.authorize("alpha")
    await completeInBrowser(authorizationUrl)
    expect(await completion).toEqual({ state: SERVER_STATE.CONNECTED })
    await settle()
    await firstEngine.dispose()

    const second = makeContext()
    const secondEngine = makeEngine(second.ctx, fileCredentials(credentials.path))
    const status = await secondEngine.configure([{ serverName: "alpha", url: provider.mcpUrl }])
    expect(status.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
    await settle()
    expect(second.tools.live()).toEqual(["mcp__alpha__echo"])
    expect(provider.refreshed).toBe(0)
    await secondEngine.dispose()
  })

  test("the Integrations section adds, authorizes, signs out and removes a server over RPC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pawwork-mcp-oauth-"))
    const list = createServerList(join(directory, "mcp-oauth.json"))
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    const engine = makeEngine(ctx, credentials, list)
    const rpc = createMcpOAuthRpcHandler({ engine }) as (
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ) => Promise<{ ok: boolean; value?: { servers: Array<{ serverName: string; state: string }>; authorizationUrl?: string }; error?: { message: string } }>

    const added = await rpc("add", { serverName: "alpha", url: provider.mcpUrl, headers: { "x-static-header": "kept" } })
    expect(added.ok).toBe(true)
    expect(added.value?.servers[0]?.state).toBe(SERVER_STATE.UNAUTHORIZED)
    expect(list.list()).toEqual([{ serverName: "alpha", url: provider.mcpUrl, headers: { "x-static-header": "kept" } }])
    expect((await rpc("add", { serverName: "alpha", url: provider.mcpUrl })).ok).toBe(false)

    const started = await rpc("authorize", { serverName: "alpha" })
    expect(started.value?.authorizationUrl).toContain("/authorize?")
    await completeInBrowser(started.value?.authorizationUrl ?? "")
    await settle(600)
    expect((await rpc("status", {})).value?.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
    expect(tools.live()).toEqual(["mcp__alpha__echo"])
    // A static header still rides every MCP request next to the OAuth token.
    expect(provider.headerValues()).toContain("kept")

    expect((await rpc("signOut", { serverName: "alpha" })).value?.servers[0]?.state).toBe(SERVER_STATE.UNAUTHORIZED)
    expect(tools.live()).toEqual([])
    expect(credentials.records.size).toBe(0)

    expect((await rpc("remove", { serverName: "alpha" })).value?.servers).toEqual([])
    expect(list.list()).toEqual([])
    await engine.dispose()
  })

  test("a corrupt server file degrades to an empty list and refuses writes until repaired", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pawwork-oauth-list-"))
    const file = join(directory, "mcp-oauth.json")
    writeFileSync(file, "{ torn write")
    const list = createServerList(file)
    expect(list.list()).toEqual([])
    expect(list.fileError()).toBeTruthy()
    expect(() => list.add({ serverName: "alpha", url: provider.mcpUrl })).toThrow(/refusing to overwrite/)
    // Repairing the file is enough; the next read clears the error.
    writeFileSync(file, JSON.stringify({ version: 1, servers: [] }))
    expect(() => list.add({ serverName: "alpha", url: provider.mcpUrl })).not.toThrow()
    expect(list.list()).toHaveLength(1)
    expect(list.fileError()).toBeUndefined()
  })

  test("the server file refuses a name that cannot address a credential record", () => {
    const directory = mkdtempSync(join(tmpdir(), "pawwork-mcp-oauth-"))
    const list = createServerList(join(directory, "mcp-oauth.json"))
    expect(() => list.add({ serverName: "has spaces", url: "https://example.com/mcp" })).toThrow(/server name/)
    expect(list.list()).toEqual([])
  })

  test("apply wires mcpAuth and the loopback channel into a real context", async () => {
    const home = mkdtempSync(join(tmpdir(), "pawwork-oauth-home-"))
    writeFileSync(join(home, "mcp-oauth.json"), JSON.stringify({ version: 1, servers: [{ serverName: "alpha", url: provider.mcpUrl }] }))
    const credentials = fileCredentials()
    const { ctx, tools } = makeContext()
    ctx.provide("credentials", credentials)
    const handled = new Map<string, (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>>()
    ctx.provide("connection", {
      rpc: {
        handle: (channel: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>) => {
          handled.set(channel, handler)
          return () => {}
        },
      },
    })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let fiber: { dispose?: () => Promise<void> } | undefined
    try {
      const plugin = await import("../../resources/dsh/mcp-oauth/lib/index.js")
      fiber = ctx.plugin(plugin as never)
      await fiber
      // The patched bridge consults this service for every transport it builds.
      expect(typeof (ctx.get("mcpAuth") as { providerFor?: unknown } | undefined)?.providerFor).toBe("function")
      const handler = handled.get("/pawwork-mcp-oauth")
      expect(handler).toBeTypeOf("function")
      await settle()
      // Startup probed the configured server, met its 401 and reads as
      // unauthorized; authorizing through the channel runs the real flow.
      const before = (await handler!("status", {})) as { value: { servers: Array<{ state: string }> } }
      expect(before.value.servers[0]?.state).toBe(SERVER_STATE.UNAUTHORIZED)
      const started = (await handler!("authorize", { serverName: "alpha" })) as { value: { authorizationUrl: string } }
      await completeInBrowser(started.value.authorizationUrl)
      await settle(600)
      const after = (await handler!("status", {})) as { value: { servers: Array<{ state: string }> } }
      expect(after.value.servers[0]?.state).toBe(SERVER_STATE.CONNECTED)
      expect(tools.live()).toEqual(["mcp__alpha__echo"])
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await fiber?.dispose?.().catch(() => {})
    }
  })

  test("all accepted names retain independent grants and unsafe OAuth URLs never persist", async () => {
    const list = createServerList(join(mkdtempSync(join(tmpdir(), "oauth-identities-")), "mcp-oauth.json"))
    const credentials = fileCredentials()
    const names = ["Alpha", "alpha", "a_b", "a-b", "___"]
    const stores = names.map((serverName) => {
      list.add({ serverName, url: provider.mcpUrl })
      return createGrantStore(credentials, { serverName, serverUrl: provider.mcpUrl })
    })
    for (const [index, store] of stores.entries()) await store.update({ tokens: { access_token: names[index] } })
    await stores[1].clear()
    expect(await stores[0].read()).toMatchObject({ tokens: { access_token: "Alpha" } })
    expect(await stores[2].read()).toMatchObject({ tokens: { access_token: "a_b" } })
    expect(await stores[3].read()).toMatchObject({ tokens: { access_token: "a-b" } })
    expect(await stores[4].read()).toMatchObject({ tokens: { access_token: "___" } })
    expect(() => list.add({ serverName: "unsafe", url: "http://example.com/mcp" })).toThrow(/https/i)
    expect(() => list.add({ serverName: "unsafe", url: "http://127.attacker.example/mcp" })).toThrow(/https/i)
    expect(() => list.add({ serverName: "unsafe", url: "https://user:pass@example.com/mcp" })).toThrow(/credentials/)
    expect(() => list.add({ serverName: "unsafe", url: "https://example.com/mcp", headers: { "bad name": "v" } })).toThrow(/header name/)
    expect(list.list().map((server: { serverName: string }) => server.serverName)).toEqual(names)
  })
})
