/**
 * Spike: can PawWork load one @deepseek-ai/dsh-mcp-client instance per MCP
 * server from its own plugin, and control that instance's lifecycle?
 *
 * Answers, in order:
 *   1. does ctx.plugin(mcpClient, config) connect and register tools under
 *      mcp__<serverName>__<name>, with no loader/cordis.yml involved;
 *   2. do two instances coexist (different serverName);
 *   3. does a duplicate serverName while live throw;
 *   4. does disposing one instance unregister exactly its tools, leaving the
 *      other alone;
 *   5. can the same serverName be forked again after disposal (reconnect =
 *      re-fork);
 *   6. do our own import and mcp-client's own import of
 *      @modelcontextprotocol/sdk resolve to the same file (the instanceof
 *      question for UnauthorizedError).
 *
 * The fake server maps one MCP server + transport per session, which is what a
 * real server does: every reconnect is a new session with its own initialize.
 */
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"

const desktop = createRequire(new URL("../package.json", import.meta.url))
const dsh = createRequire(desktop.resolve("@deepseek-ai/dsh/package.json"))
const { Context } = (await import(dsh.resolve("@deepseek-ai/cordis"))) as any
const mcpEntry = dsh.resolve("@deepseek-ai/dsh-mcp-client")
const fromMcp = createRequire(mcpEntry)

const mcp = (await import(mcpEntry)) as any
const { Server } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/server/index.js"))) as any
const { StreamableHTTPServerTransport } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"))) as any
const { ListToolsRequestSchema, CallToolRequestSchema } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/types.js"))) as any
const { Client } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/client/index.js"))) as any
const { StreamableHTTPClientTransport } = (await import(fromMcp.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"))) as any

console.log("mcp-client entry:", mcpEntry)
console.log("sdk (ours):       ", fromMcp.resolve("@modelcontextprotocol/sdk/client/index.js"))
console.log("sdk (mcp-client): ", fromMcp.resolve("@modelcontextprotocol/sdk/package.json"))

function buildServer(label: string) {
  const server = new Server({ name: label, version: "0.0.1" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", description: label + " echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => ({
    content: [{ type: "text", text: label + ":" + String(request.params?.arguments?.text ?? "") }],
  }))
  return server
}

async function fakeServer(label: string) {
  let requests = 0
  let sessions = 0
  const bySession = new Map<string, any>()
  const http = createServer((request, response) => {
    requests += 1
    const sessionId = request.headers["mcp-session-id"]
    void (async () => {
      let transport = typeof sessionId === "string" ? bySession.get(sessionId) : undefined
      if (!transport) {
        sessions += 1
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id: string) => bySession.set(id, transport),
        })
        transport.onclose = () => {
          const id = transport?.sessionId
          if (typeof id === "string") bySession.delete(id)
        }
        await buildServer(label).connect(transport)
      }
      await transport.handleRequest(request, response)
    })().catch((error: unknown) => {
      console.error("[fake " + label + "] request failed", error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  return {
    url: "http://127.0.0.1:" + address.port + "/mcp",
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
    stats: () => ({ requests, sessions }),
  }
}

const registered = new Map<string, number>()
const disposals: string[] = []
const ctx = new Context()
ctx.provide("logger", {
  info: () => {},
  warn: (...args: unknown[]) => console.warn("[mcp warn]", ...args),
  error: (...args: unknown[]) => console.error("[mcp error]", ...args),
  debug: () => {},
})
ctx.provide("tools", {
  register(definition: { name: string }) {
    registered.set(definition.name, (registered.get(definition.name) ?? 0) + 1)
    return () => {
      disposals.push(definition.name)
      const left = (registered.get(definition.name) ?? 1) - 1
      if (left <= 0) registered.delete(definition.name)
      else registered.set(definition.name, left)
    }
  },
})

const live = () => [...registered.keys()].sort()
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function assert(condition: boolean, label: string) {
  console.log((condition ? "PASS  " : "FAIL  ") + label)
  if (!condition) process.exitCode = 1
}

const probe = await fakeServer("probe")
const probeClient = new Client({ name: "probe", version: "0" })
await probeClient.connect(new StreamableHTTPClientTransport(new URL(probe.url)))
const probeTools = await probeClient.listTools()
console.log("direct SDK client sees:", JSON.stringify(probeTools.tools.map((tool: any) => tool.name)))
await probeClient.close()
await probe.close()

const a = await fakeServer("alpha")
const b = await fakeServer("beta")
const forkConfig = (serverName: string, url: string) => ({ transport: "streamable-http", serverName, url, headers: {}, reconnect: { maxAttempts: 3 }, failOnStartupError: true })

const forkA1 = await ctx.plugin(mcp, forkConfig("spike-a", a.url))
await settle(1000)
assert(JSON.stringify(live()) === JSON.stringify(["mcp__spike-a__echo"]), "one instance registers its tool: " + JSON.stringify(live()))

const forkB = await ctx.plugin(mcp, forkConfig("spike-b", b.url))
await settle(1000)
assert(JSON.stringify(live()) === JSON.stringify(["mcp__spike-a__echo", "mcp__spike-b__echo"]), "two instances coexist: " + JSON.stringify(live()))

let duplicateThrew = false
try {
  await ctx.plugin(mcp, forkConfig("spike-a", a.url))
} catch (error) {
  duplicateThrew = String(error).includes("already in use")
}
assert(duplicateThrew, "duplicate serverName while live throws")

await forkA1.dispose()
await settle(500)
assert(JSON.stringify(live()) === JSON.stringify(["mcp__spike-b__echo"]), "disposing one instance unregisters only its tools: " + JSON.stringify(live()))

const forkA2 = await ctx.plugin(mcp, forkConfig("spike-a", a.url))
await settle(1000)
assert(JSON.stringify(live()) === JSON.stringify(["mcp__spike-a__echo", "mcp__spike-b__echo"]), "same serverName forks again after disposal (reconnect = re-fork): " + JSON.stringify(live()))

await forkA2.dispose()
await forkB.dispose()
await settle(400)
assert(live().length === 0, "all tools unregistered after disposing everything: " + JSON.stringify(live()))
assert(disposals.length === 3, "every successful registration returned a disposer that fired: " + disposals.length)
console.log("fake server stats: alpha=" + JSON.stringify(a.stats()) + " beta=" + JSON.stringify(b.stats()))

// A server that refuses every request the way an OAuth-protected one does:
// forking it must fail loudly and register nothing, so PawWork can complete the
// authorization flow before it ever forks.
const refusing = await new Promise<{ url: string; close(): Promise<void>; hits(): number }>((resolve) => {
  let hits = 0
  const http = createServer((_request, response) => {
    hits += 1
    response.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="OAuth", resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    })
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid access token" }, id: null }))
  })
  http.listen(0, "127.0.0.1", () => {
    const address = http.address()
    if (address === null || typeof address === "string") throw new Error("no port")
    resolve({
      url: "http://127.0.0.1:" + address.port + "/mcp",
      close: () => new Promise<void>((done) => http.close(() => done())),
      hits: () => hits,
    })
  })
})
let refusedThrew = false
try {
  await ctx.plugin(mcp, forkConfig("spike-refused", refusing.url))
} catch (error) {
  refusedThrew = true
}
assert(refusedThrew, "a 401-protected server fails the fork loudly (attempts: " + refusing.hits() + ")")
assert(live().length === 0, "a refused fork registers no tools: " + JSON.stringify(live()))
await refusing.close()

await a.close()
await b.close()
console.log("spike done, exit", process.exitCode ?? 0)
