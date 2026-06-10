import { test, expect, mock, beforeEach } from "bun:test"

// --- Mock infrastructure ---

// Per-client state for controlling mock behavior
interface MockClientState {
  capabilities: { tools?: object | null; prompts?: object | null; resources?: object | null }
  tools: Array<{ name: string; description?: string; inputSchema: object; outputSchema?: object }>
  listToolsCalls: number
  listPromptsCalls: number
  listResourcesCalls: number
  getPromptTimeouts: Array<number | undefined>
  readResourceTimeouts: Array<number | undefined>
  requestCalls: number
  capabilitiesShouldThrow: boolean
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  toolPages: Record<
    string,
    {
      tools: Array<{ name: string; description?: string; inputSchema: object; outputSchema?: object }>
      nextCursor?: string | null
    }
  >
  promptPages: Record<string, { prompts: Array<{ name: string; description?: string }>; nextCursor?: string | null }>
  resourcePages: Record<
    string,
    { resources: Array<{ name: string; uri: string; description?: string }>; nextCursor?: string | null }
  >
  callToolSignals: Array<AbortSignal | undefined>
  callToolTimeouts: Array<number | undefined>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
// Tracks how many Client instances were created (detects leaks)
let clientCreateCount = 0
// Tracks how many times transport.close() is called across all mock transports
let transportCloseCount = 0

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listPromptsCalls: 0,
      listResourcesCalls: 0,
      getPromptTimeouts: [],
      readResourceTimeouts: [],
      requestCalls: 0,
      capabilitiesShouldThrow: false,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      toolPages: {},
      promptPages: {},
      resourcePages: {},
      callToolSignals: [],
      callToolTimeouts: [],
      closed: false,
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

// Mock transport that succeeds or fails based on connectShouldFail / connectShouldHang
class MockStdioTransport {
  stderr: null = null
  pid = 12345
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockSSE {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {}) // never resolves
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

// Mock Client that delegates to per-name MockClientState
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_opts: any) {
      clientCreateCount++
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      // After successful connect, bind to the last-created client name
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    getServerCapabilities() {
      if (this._state?.capabilitiesShouldThrow) throw new Error("capability discovery failed")
      return this._state?.capabilities
    }

    async listTools(params?: { cursor?: string }) {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      const page = this._state?.toolPages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { tools: this._state?.tools ?? [] }
    }

    async request(
      request: { method: string; params?: { cursor?: string } },
      schema: { parse: (value: unknown) => unknown },
    ) {
      if (this._state) this._state.requestCalls++
      if (request.method === "tools/list") {
        return schema.parse(
          this._state?.toolPages[request.params === undefined ? "initial" : (request.params.cursor ?? "")] ?? {
            tools: this._state?.tools ?? [],
          },
        )
      }
      throw new Error(`unsupported request: ${request.method}`)
    }

    async listPrompts(params?: { cursor?: string }) {
      if (this._state) this._state.listPromptsCalls++
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      const page = this._state?.promptPages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources(params?: { cursor?: string }) {
      if (this._state) this._state.listResourcesCalls++
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      const page = this._state?.resourcePages[params === undefined ? "initial" : (params.cursor ?? "")]
      if (page) return page
      return { resources: this._state?.resources ?? [] }
    }

    async getPrompt(_params: unknown, options?: { timeout?: number }) {
      this._state?.getPromptTimeouts.push(options?.timeout)
      return { messages: [] }
    }

    async readResource(params: { uri: string }, options?: { timeout?: number }) {
      this._state?.readResourceTimeouts.push(options?.timeout)
      return { contents: [{ uri: params.uri, text: "test" }] }
    }

    async callTool(_args: unknown, _schema: unknown, options?: { signal?: AbortSignal; timeout?: number }) {
      this._state?.callToolSignals.push(options?.signal)
      this._state?.callToolTimeouts.push(options?.timeout)
      return { content: [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

// Import after mocks
const { MCP } = await import("../../src/mcp/index")
const { Bus } = await import("../../src/bus/index")
const { Instance } = await import("../../src/project/instance")
const { NotFoundError } = await import("../../src/storage/db")
const { tmpdir } = await import("../fixture/fixture")
const { makeRuntime } = await import("../../src/effect/run-service")
const mcpRuntime = makeRuntime(MCP.Service, MCP.defaultLayer)

// --- Helper ---

function withInstance(config: Record<string, any>, fn: () => Promise<void>, extraConfig: Record<string, any> = {}) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            ...extraConfig,
            mcp: config,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
        // dispose instance to clean up state between tests
        await Instance.dispose()
      },
    })
  }
}

// ========================================================================
// Test: tools() are cached after connect
// ========================================================================

test(
  "tools() reuses cached tool definitions after connect",
  withInstance({}, async () => {
    lastCreatedClientName = "my-server"
    const serverState = getOrCreateClientState("my-server")
    serverState.tools = [
      { name: "do_thing", description: "does a thing", inputSchema: { type: "object", properties: {} } },
    ]

    // First: add the server successfully
    const addResult = await MCP.add("my-server", {
      type: "local",
      command: ["echo", "test"],
    })
    expect((addResult.status as any)["my-server"]?.status ?? (addResult.status as any).status).toBe("connected")

    expect(serverState.listToolsCalls).toBe(1)

    const toolsA = await MCP.tools()
    const toolsB = await MCP.tools()
    expect(Object.keys(toolsA).length).toBeGreaterThan(0)
    expect(Object.keys(toolsB).length).toBeGreaterThan(0)
    expect(serverState.listToolsCalls).toBe(1)
  }),
)

// ========================================================================
// Test: tool change notifications refresh the cache
// ========================================================================

test(
  "tool change notifications refresh cached tool definitions",
  withInstance({}, async () => {
    lastCreatedClientName = "status-server"
    const serverState = getOrCreateClientState("status-server")

    await MCP.add("status-server", {
      type: "local",
      command: ["echo", "test"],
    })

    const before = await MCP.tools()
    expect(Object.keys(before).some((key) => key.includes("test_tool"))).toBe(true)
    expect(serverState.listToolsCalls).toBe(1)

    serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]

    const handler = Array.from(serverState.notificationHandlers.values())[0]
    expect(handler).toBeDefined()
    await handler?.()

    const after = await MCP.tools()
    expect(Object.keys(after).some((key) => key.includes("next_tool"))).toBe(true)
    expect(Object.keys(after).some((key) => key.includes("test_tool"))).toBe(false)
    expect(serverState.listToolsCalls).toBe(2)
  }),
)

test(
  "capabilities prevent unsupported catalog calls",
  withInstance({}, async () => {
    lastCreatedClientName = "resource-only-server"
    const serverState = getOrCreateClientState("resource-only-server")
    serverState.capabilities = { resources: {} }
    serverState.resources = [{ name: "docs", uri: "docs://readme" }]

    const addResult = await MCP.add("resource-only-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect((addResult.status as any)["resource-only-server"]?.status ?? (addResult.status as any).status).toBe(
      "connected",
    )
    expect(serverState.listToolsCalls).toBe(0)
    expect(serverState.notificationHandlers.size).toBe(0)
    expect(await MCP.tools()).toEqual({})
    expect(Object.keys(await MCP.resources())).toEqual(["resource-only-server:docs"])
    expect(serverState.listResourcesCalls).toBe(1)
    expect(serverState.listPromptsCalls).toBe(0)

    lastCreatedClientName = "tools-only-server"
    const toolsOnlyState = getOrCreateClientState("tools-only-server")
    toolsOnlyState.capabilities = { tools: {} }

    await MCP.add("tools-only-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(Object.keys(await MCP.tools())).toEqual(["tools-only-server_test_tool"])
    expect(await MCP.prompts()).toEqual({})
    expect(toolsOnlyState.listPromptsCalls).toBe(0)
    expect(toolsOnlyState.listResourcesCalls).toBe(0)

    lastCreatedClientName = "null-tools-server"
    const nullToolsState = getOrCreateClientState("null-tools-server")
    nullToolsState.capabilities = { tools: null, resources: {} }
    nullToolsState.resources = [{ name: "null-docs", uri: "docs://null" }]

    await MCP.add("null-tools-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(nullToolsState.listToolsCalls).toBe(0)
    expect(Object.keys(await MCP.resources())).toContain("null-tools-server:null-docs")
  }),
)

test(
  "catalog listing follows cursors and stops duplicate cursors",
  withInstance({}, async () => {
    lastCreatedClientName = "paged-server"
    const pagedState = getOrCreateClientState("paged-server")
    pagedState.toolPages = {
      initial: { tools: [{ name: "tool-one", inputSchema: { type: "object", properties: {} } }], nextCursor: "t2" },
      t2: { tools: [{ name: "tool-two", inputSchema: { type: "object", properties: {} } }] },
    }
    pagedState.promptPages = {
      initial: { prompts: [{ name: "prompt-one" }], nextCursor: "p2" },
      p2: { prompts: [{ name: "prompt-two" }] },
    }
    pagedState.resourcePages = {
      initial: { resources: [{ name: "resource-one", uri: "test://one" }], nextCursor: "" },
      "": { resources: [{ name: "resource-two", uri: "test://two" }], nextCursor: null },
    }

    await MCP.add("paged-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(Object.keys(await MCP.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
    expect(Object.keys(await MCP.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
    expect(Object.keys(await MCP.resources())).toEqual(["paged-server:resource-one", "paged-server:resource-two"])
    expect(pagedState.listToolsCalls).toBe(2)
    expect(pagedState.listPromptsCalls).toBe(2)
    expect(pagedState.listResourcesCalls).toBe(2)

    lastCreatedClientName = "looping-server"
    const loopingState = getOrCreateClientState("looping-server")
    loopingState.toolPages = {
      initial: { tools: [], nextCursor: "repeat" },
      repeat: { tools: [], nextCursor: "repeat" },
    }

    const addResult = await MCP.add("looping-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect((addResult.status as any)["looping-server"]?.status ?? (addResult.status as any).status).toBe("failed")
    expect(loopingState.listToolsCalls).toBe(2)
  }),
)

test(
  "add records failed status and closes the client when capability probing throws",
  withInstance({}, async () => {
    lastCreatedClientName = "defective-server"
    const serverState = getOrCreateClientState("defective-server")
    serverState.capabilitiesShouldThrow = true

    const addResult = await MCP.add("defective-server", {
      type: "local",
      command: ["echo", "test"],
    })

    const serverStatus = (addResult.status as any)["defective-server"] ?? addResult.status
    expect(serverStatus).toEqual({ status: "failed", error: "capability discovery failed" })
    expect((await MCP.status())["defective-server"]).toEqual({
      status: "failed",
      error: "capability discovery failed",
    })
    expect(serverState.closed).toBe(true)
  }),
)

test(
  "tool execution forwards abort signals to MCP callTool",
  withInstance({}, async () => {
    lastCreatedClientName = "abort-server"
    const serverState = getOrCreateClientState("abort-server")

    await MCP.add("abort-server", {
      type: "local",
      command: ["echo", "test"],
    })

    const tools = await MCP.tools()
    const tool = tools["abort-server_test_tool"] as unknown as {
      execute: (args: unknown, options: { abortSignal: AbortSignal }) => any
    }
    const controller = new AbortController()

    await tool.execute({}, { abortSignal: controller.signal })

    expect(serverState.callToolSignals).toEqual([controller.signal])
  }),
)

test(
  "prompt and resource requests use per-server timeout before experimental fallback",
  withInstance(
    {},
    async () => {
      lastCreatedClientName = "timeout-server"
      const timeoutState = getOrCreateClientState("timeout-server")

      await MCP.add("timeout-server", {
        type: "local",
        command: ["echo", "test"],
        timeout: 2500,
      })
      await mcpRuntime.runPromise((mcp) => mcp.getPrompt("timeout-server", "test"))
      await mcpRuntime.runPromise((mcp) => mcp.readResource("timeout-server", "test://resource"))

      expect(timeoutState.getPromptTimeouts).toEqual([2500])
      expect(timeoutState.readResourceTimeouts).toEqual([2500])

      lastCreatedClientName = "fallback-server"
      const fallbackState = getOrCreateClientState("fallback-server")

      await MCP.add("fallback-server", {
        type: "local",
        command: ["echo", "test"],
      })
      await mcpRuntime.runPromise((mcp) => mcp.getPrompt("fallback-server", "test"))
      await mcpRuntime.runPromise((mcp) => mcp.readResource("fallback-server", "test://resource"))

      expect(fallbackState.getPromptTimeouts).toEqual([5000])
      expect(fallbackState.readResourceTimeouts).toEqual([5000])
    },
    { experimental: { mcp_timeout: 5000 } },
  ),
)

// ========================================================================
// Test: tool change notifications publish ToolsChanged on the instance bus (#22504)
// The MCP SDK fires the notification handler from a detached transport callback,
// outside the instance async context. The buggy handler ran bus.publish via a bare
// Effect.runPromise, so InstanceState.get found no instance and the event silently
// never reached subscribers (the cache still refreshed, but the UI was never told).
// Firing the captured handler OUTSIDE Instance.provide reproduces that detached
// context; a real subscriber must still receive the event.
// ========================================================================

test("tool change notification reaches the instance bus from a detached callback", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/opencode.json`,
        JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: {} }),
      )
    },
  })

  const received: string[] = []
  let detachedHandler: (() => Promise<void>) | undefined
  let unsubscribe: (() => void) | undefined

  // Set up the server + subscriber inside the instance context, then leave the
  // instance alive (no dispose) so the bus can still deliver after we exit.
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      lastCreatedClientName = "notify-server"
      const serverState = getOrCreateClientState("notify-server")

      await MCP.add("notify-server", { type: "local", command: ["echo", "test"] })

      unsubscribe = Bus.subscribe(MCP.ToolsChanged, (event) => {
        received.push(event.properties.server)
      })

      serverState.tools = [{ name: "next_tool", description: "next", inputSchema: { type: "object", properties: {} } }]
      detachedHandler = Array.from(serverState.notificationHandlers.values())[0]
    },
  })

  try {
    // Fire OUTSIDE the instance ALS — mirrors the MCP SDK transport callback.
    // The SDK treats the handler as fire-and-forget, so a rejection is swallowed
    // there too; tolerate it and let the received-event assertion be the pivot.
    expect(detachedHandler).toBeDefined()
    await detachedHandler?.().catch(() => {})

    // Bus delivery happens on a forked fiber consuming the PubSub; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(received).toContain("notify-server")
  } finally {
    unsubscribe?.()
    await Instance.disposeDirectory(tmp.path)
  }
})

// ========================================================================
// Test: connect() / disconnect() lifecycle
// ========================================================================

test(
  "disconnect sets status to disabled and removes client",
  withInstance(
    {
      "disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "disc-server"
      getOrCreateClientState("disc-server")

      await MCP.add("disc-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const statusBefore = await MCP.status()
      expect(statusBefore["disc-server"]?.status).toBe("connected")

      await MCP.disconnect("disc-server")

      const statusAfter = await MCP.status()
      expect(statusAfter["disc-server"]?.status).toBe("disabled")

      // Tools should be empty after disconnect
      const tools = await MCP.tools()
      const serverTools = Object.keys(tools).filter((k) => k.startsWith("disc-server"))
      expect(serverTools.length).toBe(0)
    },
  ),
)

test(
  "connect() after disconnect() re-establishes the server",
  withInstance(
    {
      "reconn-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "reconn-server"
      const serverState = getOrCreateClientState("reconn-server")
      serverState.tools = [{ name: "my_tool", description: "a tool", inputSchema: { type: "object", properties: {} } }]

      await MCP.add("reconn-server", {
        type: "local",
        command: ["echo", "test"],
      })

      await MCP.disconnect("reconn-server")
      expect((await MCP.status())["reconn-server"]?.status).toBe("disabled")

      // Reconnect
      await MCP.connect("reconn-server")
      expect((await MCP.status())["reconn-server"]?.status).toBe("connected")

      const tools = await MCP.tools()
      expect(Object.keys(tools).some((k) => k.includes("my_tool"))).toBe(true)
    },
  ),
)

// ========================================================================
// Test: add() closes existing client before replacing
// ========================================================================

test(
  "add() closes the old client when replacing a server",
  // Don't put the server in config — add it dynamically so we control
  // exactly which client instance is "first" vs "second".
  withInstance({}, async () => {
    lastCreatedClientName = "replace-server"
    const firstState = getOrCreateClientState("replace-server")

    await MCP.add("replace-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(firstState.closed).toBe(false)

    // Create new state for second client
    clientStates.delete("replace-server")
    const secondState = getOrCreateClientState("replace-server")

    // Re-add should close the first client
    await MCP.add("replace-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect(firstState.closed).toBe(true)
    expect(secondState.closed).toBe(false)
  }),
)

test(
  "dynamically added servers keep config for status reconnect and tool timeout",
  withInstance({}, async () => {
    lastCreatedClientName = "dynamic-server"
    const serverState = getOrCreateClientState("dynamic-server")

    await MCP.add("dynamic-server", {
      type: "local",
      command: ["echo", "test"],
      timeout: 1234,
    })

    expect((await MCP.status())["dynamic-server"]?.status).toBe("connected")

    const tools = await MCP.tools()
    const tool = tools["dynamic-server_test_tool"] as unknown as {
      execute: (args: unknown, options?: { abortSignal?: AbortSignal }) => any
    }
    await tool.execute({})
    expect(serverState.callToolTimeouts).toEqual([1234])

    await MCP.disconnect("dynamic-server")
    expect((await MCP.status())["dynamic-server"]?.status).toBe("disabled")

    clientStates.delete("dynamic-server")
    lastCreatedClientName = "dynamic-server"
    const reconnectedState = getOrCreateClientState("dynamic-server")

    await MCP.connect("dynamic-server")
    expect((await MCP.status())["dynamic-server"]?.status).toBe("connected")

    const reconnectedTools = await MCP.tools()
    const reconnectedTool = reconnectedTools["dynamic-server_test_tool"] as unknown as {
      execute: (args: unknown, options?: { abortSignal?: AbortSignal }) => any
    }
    await reconnectedTool.execute({})
    expect(reconnectedState.callToolTimeouts).toEqual([1234])
  }),
)

// ========================================================================
// Test: state init with mixed success/failure
// ========================================================================

test(
  "init connects available servers even when one fails",
  withInstance(
    {
      "good-server": {
        type: "local",
        command: ["echo", "good"],
      },
      "bad-server": {
        type: "local",
        command: ["echo", "bad"],
      },
    },
    async () => {
      // Set up good server
      const goodState = getOrCreateClientState("good-server")
      goodState.tools = [{ name: "good_tool", description: "works", inputSchema: { type: "object", properties: {} } }]

      // Set up bad server - will fail on listTools during create()
      const badState = getOrCreateClientState("bad-server")
      badState.listToolsShouldFail = true

      // Add good server first
      lastCreatedClientName = "good-server"
      await MCP.add("good-server", {
        type: "local",
        command: ["echo", "good"],
      })

      // Add bad server - should fail but not affect good server
      lastCreatedClientName = "bad-server"
      await MCP.add("bad-server", {
        type: "local",
        command: ["echo", "bad"],
      })

      const status = await MCP.status()
      expect(status["good-server"]?.status).toBe("connected")
      expect(status["bad-server"]?.status).toBe("failed")

      // Good server's tools should still be available
      const tools = await MCP.tools()
      expect(Object.keys(tools).some((k) => k.includes("good_tool"))).toBe(true)
    },
  ),
)

// ========================================================================
// Test: tolerate output-schema $ref failures (#26614)
// ========================================================================

test(
  "falls back when MCP output schema refs fail SDK tool discovery",
  withInstance({}, async () => {
    lastCreatedClientName = "stitch-like-server"
    const serverState = getOrCreateClientState("stitch-like-server")
    serverState.listToolsShouldFail = true
    serverState.listToolsError = "can't resolve reference #/$defs/ScreenInstance from id #"
    serverState.tools = [
      {
        name: "render_screen",
        description: "renders a screen",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
      },
    ]

    const addResult = await MCP.add("stitch-like-server", {
      type: "local",
      command: ["echo", "test"],
    })

    const serverStatus = (addResult.status as any)["stitch-like-server"] ?? addResult.status
    expect(serverStatus.status).toBe("connected")

    const tools = await MCP.tools()
    expect(Object.keys(tools).some((key) => key.includes("render_screen"))).toBe(true)
    expect(serverState.listToolsCalls).toBe(1)
    expect(serverState.requestCalls).toBe(1)
  }),
)

test(
  "does not fall back for non-schema MCP tool discovery errors",
  withInstance({}, async () => {
    lastCreatedClientName = "broken-server"
    const serverState = getOrCreateClientState("broken-server")
    serverState.listToolsShouldFail = true
    serverState.listToolsError = "transport closed"

    const addResult = await MCP.add("broken-server", {
      type: "local",
      command: ["echo", "test"],
    })

    const serverStatus = (addResult.status as any)["broken-server"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    expect(serverState.listToolsCalls).toBe(1)
    expect(serverState.requestCalls).toBe(0)
  }),
)

// ========================================================================
// Test: disabled server via config
// ========================================================================

test(
  "disabled server is marked as disabled without attempting connection",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    async () => {
      const countBefore = clientCreateCount

      await MCP.add("disabled-server", {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      } as any)

      // No client should have been created
      expect(clientCreateCount).toBe(countBefore)

      const status = await MCP.status()
      expect(status["disabled-server"]?.status).toBe("disabled")
    },
  ),
)

// ========================================================================
// Test: prompts() and resources()
// ========================================================================

test(
  "prompts() returns prompts from connected servers",
  withInstance(
    {
      "prompt-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "prompt-server"
      const serverState = getOrCreateClientState("prompt-server")
      serverState.prompts = [{ name: "my-prompt", description: "A test prompt" }]

      await MCP.add("prompt-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const prompts = await MCP.prompts()
      expect(Object.keys(prompts).length).toBe(1)
      const key = Object.keys(prompts)[0]
      expect(key).toContain("prompt-server")
      expect(key).toContain("my-prompt")
    },
  ),
)

test(
  "resources() returns resources from connected servers",
  withInstance(
    {
      "resource-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "resource-server"
      const serverState = getOrCreateClientState("resource-server")
      serverState.resources = [{ name: "my-resource", uri: "file:///test.txt", description: "A test resource" }]

      await MCP.add("resource-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const resources = await MCP.resources()
      expect(Object.keys(resources).length).toBe(1)
      const key = Object.keys(resources)[0]
      expect(key).toContain("resource-server")
      expect(key).toContain("my-resource")
    },
  ),
)

test(
  "prompts() skips disconnected servers",
  withInstance(
    {
      "prompt-disc-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "prompt-disc-server"
      const serverState = getOrCreateClientState("prompt-disc-server")
      serverState.prompts = [{ name: "hidden-prompt", description: "Should not appear" }]

      await MCP.add("prompt-disc-server", {
        type: "local",
        command: ["echo", "test"],
      })

      await MCP.disconnect("prompt-disc-server")

      const prompts = await MCP.prompts()
      expect(Object.keys(prompts).length).toBe(0)
    },
  ),
)

// ========================================================================
// Test: connect() on an unknown server name surfaces NotFoundError (#28817)
// connect() used to log + bare-return for an unknown name, so the route
// reported 200 for a server that was never connected. It now throws the
// shared NotFoundError (storage/db), which ErrorMiddleware maps to 404.
// instanceof NotFoundError is exactly the check the middleware relies on.
// ========================================================================

test(
  "connect() on an unknown server name rejects with NotFoundError",
  withInstance({}, async () => {
    let caught: unknown
    await MCP.connect("nonexistent").catch((err) => {
      caught = err
    })
    expect(caught).toBeInstanceOf(NotFoundError)

    // The unknown server is never registered.
    const status = await MCP.status()
    expect(status["nonexistent"]).toBeUndefined()
  }),
)

// ========================================================================
// Test: disconnect() on nonexistent server
// ========================================================================

test(
  "disconnect() on nonexistent server does not throw",
  withInstance({}, async () => {
    await MCP.disconnect("nonexistent")
    // Should complete without error
  }),
)

// ========================================================================
// Test: tools() with no MCP servers configured
// ========================================================================

test(
  "tools() returns empty when no MCP servers are configured",
  withInstance({}, async () => {
    const tools = await MCP.tools()
    expect(Object.keys(tools).length).toBe(0)
  }),
)

// ========================================================================
// Test: connect failure during create()
// ========================================================================

test(
  "server that fails to connect is marked as failed",
  withInstance(
    {
      "fail-connect": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "fail-connect"
      getOrCreateClientState("fail-connect")
      connectShouldFail = true
      connectError = "Connection refused"

      await MCP.add("fail-connect", {
        type: "local",
        command: ["echo", "test"],
      })

      const status = await MCP.status()
      expect(status["fail-connect"]?.status).toBe("failed")
      if (status["fail-connect"]?.status === "failed") {
        expect(status["fail-connect"].error).toContain("Connection refused")
      }

      // No tools should be available
      const tools = await MCP.tools()
      expect(Object.keys(tools).length).toBe(0)
    },
  ),
)

// ========================================================================
// Bug #5: McpOAuthCallback.cancelPending uses wrong key
// ========================================================================

test("McpOAuthCallback.cancelPending is keyed by mcpName but pendingAuths uses oauthState", async () => {
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

  // Register a pending auth with an oauthState key, associated to an mcpName
  const oauthState = "abc123hexstate"
  const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, "my-mcp-server")

  // cancelPending is called with mcpName — should find the entry via reverse index
  McpOAuthCallback.cancelPending("my-mcp-server")

  // The callback should still be pending because cancelPending looked up
  // "my-mcp-server" in a map keyed by "abc123hexstate"
  let resolved = false
  let rejected = false
  callbackPromise.then(() => (resolved = true)).catch(() => (rejected = true))

  // Give it a tick
  await new Promise((r) => setTimeout(r, 50))

  // cancelPending("my-mcp-server") should have rejected the pending callback
  expect(rejected).toBe(true)

  await McpOAuthCallback.stop()
})

// ========================================================================
// Test: multiple tools from same server get correct name prefixes
// ========================================================================

test(
  "tools() prefixes tool names with sanitized server name",
  withInstance(
    {
      "my.special-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "my.special-server"
      const serverState = getOrCreateClientState("my.special-server")
      serverState.tools = [
        { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
        { name: "tool.b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
      ]

      await MCP.add("my.special-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const tools = await MCP.tools()
      const keys = Object.keys(tools)

      // Server name dots should be replaced with underscores
      expect(keys.some((k) => k.startsWith("my_special-server_"))).toBe(true)
      // Tool name dots should be replaced with underscores
      expect(keys.some((k) => k.endsWith("tool_b"))).toBe(true)
      expect(keys.length).toBe(2)
    },
  ),
)

// ========================================================================
// Test: transport leak — local stdio timeout (#19168)
// ========================================================================

test(
  "local stdio transport is closed when connect times out (no process leak)",
  withInstance({}, async () => {
    lastCreatedClientName = "hanging-server"
    getOrCreateClientState("hanging-server")
    connectShouldHang = true

    const addResult = await MCP.add("hanging-server", {
      type: "local",
      command: ["node", "fake.js"],
      timeout: 100,
    })

    const serverStatus = (addResult.status as any)["hanging-server"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    expect(serverStatus.error).toContain("timed out")
    // Transport must be closed to avoid orphaned child process
    expect(transportCloseCount).toBeGreaterThanOrEqual(1)
  }),
)

// ========================================================================
// Test: transport leak — remote timeout (#19168)
// ========================================================================

test(
  "remote transport is closed when connect times out",
  withInstance({}, async () => {
    lastCreatedClientName = "hanging-remote"
    getOrCreateClientState("hanging-remote")
    connectShouldHang = true

    const addResult = await MCP.add("hanging-remote", {
      type: "remote",
      url: "http://localhost:9999/mcp",
      timeout: 100,
      oauth: false,
    })

    const serverStatus = (addResult.status as any)["hanging-remote"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    // Transport must be closed to avoid leaked HTTP connections
    expect(transportCloseCount).toBeGreaterThanOrEqual(1)
  }),
)

// ========================================================================
// Test: transport leak — failed remote transports not closed (#19168)
// ========================================================================

test(
  "failed remote transport is closed before trying next transport",
  withInstance({}, async () => {
    lastCreatedClientName = "fail-remote"
    getOrCreateClientState("fail-remote")
    connectShouldFail = true
    connectError = "Connection refused"

    const addResult = await MCP.add("fail-remote", {
      type: "remote",
      url: "http://localhost:9999/mcp",
      timeout: 5000,
      oauth: false,
    })

    const serverStatus = (addResult.status as any)["fail-remote"] ?? addResult.status
    expect(serverStatus.status).toBe("failed")
    // Both StreamableHTTP and SSE transports should be closed
    expect(transportCloseCount).toBeGreaterThanOrEqual(2)
  }),
)
