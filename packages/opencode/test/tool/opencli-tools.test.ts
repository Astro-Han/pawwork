import { describe, expect, test } from "bun:test"
import { cli, getRegistry } from "@jackwener/opencli/registry"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, type Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { BrowserBridge } from "../../src/browser/browser-bridge"
import { resetBrowserSessionsForTest } from "../../src/browser/session"
import { provideTmpdirInstance } from "../fixture/fixture"
import { FakeCdpServer, provideFakeHost, scriptCurrentUrl } from "../fake/cdp-server"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { OpenCliRunTool } from "../../src/tool/opencli-run"
import { formatOpenCliSearchOutput, OpenCliSearchTool } from "../../src/tool/opencli-search"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_opencli_tools"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

type AnyToolEffect = Effect.Effect<Tool.Info<Schema.Decoder<unknown>, Record<string, unknown>>, never, never>

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer))

function exec(tool: unknown, args: unknown, ctxOverride: Partial<Tool.Context> = {}) {
  return provideTmpdirInstance(() =>
    (tool as AnyToolEffect).pipe(
      Effect.flatMap((info) => info.init()),
      Effect.flatMap((t) => t.execute(args as never, { ...ctx, ...ctxOverride } as never)),
    ),
  )
}

describe("opencli_search", () => {
  it.live("returns discoverable bundled adapter commands without blocked commands", () =>
    Effect.gen(function* () {
      const result = yield* exec(OpenCliSearchTool, { query: "12306/me", limit: 5 })

      expect(result.title).toBe('OpenCLI commands for "12306/me"')
      expect(result.output).toContain('<opencli_command name="12306/me">')
      expect(result.output).toContain("browser: true")
      expect(result.output).not.toContain("instagram/reel")
      expect(result.metadata).toMatchObject({ query: "12306/me" })
    }),
  )

  it.live("includes adapter argument metadata needed to run a command", () =>
    Effect.gen(function* () {
      cli({
        site: "pawwork-test",
        name: "metadata",
        access: "read",
        description: "Metadata test adapter",
        browser: false,
        args: [
          { name: "query", type: "string", required: true, help: "Search text" },
          { name: "limit", type: "int", default: 5, help: "Maximum results" },
          { name: "sort", choices: ["new", "top"], default: "new" },
        ],
        func: async () => [],
      })

      try {
        const result = yield* exec(OpenCliSearchTool, { query: "pawwork-test/metadata", limit: 1 })

        expect(result.output).toContain('<opencli_command name="pawwork-test/metadata">')
        expect(result.output).toContain("- query (required) | type: string | help: Search text")
        expect(result.output).toContain("- limit | type: int | default: 5 | help: Maximum results")
        expect(result.output).toContain('- sort | choices: [new, top] | default: "new"')
      } finally {
        getRegistry().delete("pawwork-test/metadata")
      }
    }),
  )

  test("shows adapter load failures after search results", () => {
    const output = formatOpenCliSearchOutput(
      [
        {
          name: "pawwork-test/search",
          description: "Search test adapter",
          access: "read",
          browser: false,
          args: [],
        },
      ],
      [{ modulePath: "broken.js", error: "boom" }],
    )

    expect(output).toContain('<opencli_command name="pawwork-test/search">')
    expect(output).toContain("Warning: 1 OpenCLI adapter module failed to load")
    expect(output).toContain("broken.js")
  })
})

describe("opencli_run", () => {
  it.live("asks for the current page when a browser command has no pre-navigation URL", () =>
    Effect.gen(function* () {
      cli({
        site: "pawwork-test",
        name: "current-page",
        access: "write",
        description: "Current page permission test adapter",
        browser: true,
        domain: "localhost",
        navigateBefore: true,
        args: [],
        func: async () => [],
      })
      BrowserBridge.provideHost({
        probeSession: async () => ({ url: "http://localhost:5173/codex" }),
        resolveEndpoint: async () => {
          throw new Error("no test endpoint")
        },
        releaseSession: async () => {},
        disposeSession: async () => {},
      })

      try {
        const askLog: Parameters<Tool.Context["ask"]>[0][] = []
        yield* exec(OpenCliRunTool, { command: "pawwork-test/current-page", args: {} }, {
          ask: (input) =>
            Effect.sync(() => {
              askLog.push(input)
            }),
        }).pipe(Effect.exit)

        expect(askLog[0]).toMatchObject({
          permission: "opencli_write",
          patterns: ["pawwork-test/current-page"],
          always: ["pawwork-test/current-page"],
        })
        expect(askLog[1]).toMatchObject({
          permission: "browser",
          patterns: ["http://localhost:5173/codex"],
        })
      } finally {
        BrowserBridge.provideHost(null)
        getRegistry().delete("pawwork-test/current-page")
      }
    }),
  )

  it.live("asks for origin and domain browser permissions for pre-navigation commands", () =>
    Effect.gen(function* () {
      cli({
        site: "pawwork-test",
        name: "browser-permission",
        access: "read",
        description: "Browser permission test adapter",
        browser: true,
        domain: "example.com",
        navigateBefore: "https://auth.example.com/login",
        args: [],
        func: async () => [],
      })
      BrowserBridge.provideHost({
        probeSession: async () => ({ url: "http://localhost:5173/codex" }),
        resolveEndpoint: async () => {
          throw new Error("no test endpoint")
        },
        releaseSession: async () => {},
        disposeSession: async () => {},
      })

      try {
        const askLog: Parameters<Tool.Context["ask"]>[0][] = []
        yield* exec(OpenCliRunTool, { command: "pawwork-test/browser-permission", args: {} }, {
          ask: (input) =>
            Effect.sync(() => {
              askLog.push(input)
            }),
        }).pipe(Effect.exit)

        expect(askLog[0]).toMatchObject({
          permission: "opencli_read",
          patterns: ["pawwork-test/browser-permission"],
          always: ["pawwork-test/browser-permission"],
        })
        expect(askLog[1]).toMatchObject({
          permission: "browser",
          patterns: ["https://auth.example.com/*", "https://example.com/*"],
        })
      } finally {
        BrowserBridge.provideHost(null)
        getRegistry().delete("pawwork-test/browser-permission")
      }
    }),
  )

  it.live("formats an undefined browser write result as empty output", () =>
    Effect.gen(function* () {
      const server = new FakeCdpServer()
      scriptCurrentUrl(server, "https://example.com/page")
      provideFakeHost(server)
      cli({
        site: "pawwork-test",
        name: "empty-browser-write",
        access: "write",
        description: "Empty browser write result test adapter",
        browser: true,
        domain: "example.com",
        args: [],
        func: async () => undefined,
      })

      try {
        const result = yield* exec(OpenCliRunTool, { command: "pawwork-test/empty-browser-write", args: {} })

        expect(result.title).toBe("OpenCLI pawwork-test/empty-browser-write")
        expect(result.output).toBe("OpenCLI adapter returned no output.")
      } finally {
        resetBrowserSessionsForTest()
        BrowserBridge.provideHost(null)
        getRegistry().delete("pawwork-test/empty-browser-write")
        yield* Effect.promise(() => server.close())
      }
    }),
  )

  it.live("asks before running a read non-browser adapter", () =>
    Effect.gen(function* () {
      cli({
        site: "pawwork-test",
        name: "echo",
        access: "read",
        description: "Echo test adapter",
        browser: false,
        args: [{ name: "query", required: true }],
        func: async (args) => [{ echoed: args.query }],
      })

      try {
        const askLog: Parameters<Tool.Context["ask"]>[0][] = []
        const result = yield* exec(OpenCliRunTool, { command: "pawwork-test/echo", args: { query: "hello" } }, {
          ask: (input) =>
            Effect.sync(() => {
              askLog.push(input)
            }),
        })

        expect(result.title).toBe("OpenCLI pawwork-test/echo")
        expect(result.output).toContain('"echoed": "hello"')
        expect(result.metadata).toMatchObject({ command: "pawwork-test/echo", browser: false })
        expect(askLog[0]).toMatchObject({
          permission: "opencli_read",
          patterns: ["pawwork-test/echo"],
          always: ["pawwork-test/echo"],
        })
      } finally {
        getRegistry().delete("pawwork-test/echo")
      }
    }),
  )

  it.live("asks before running a write non-browser adapter", () =>
    Effect.gen(function* () {
      cli({
        site: "pawwork-test",
        name: "write-http",
        access: "write",
        description: "Write non-browser test adapter",
        browser: false,
        args: [{ name: "query", required: true }],
        func: async (args) => [{ written: args.query }],
      })

      try {
        const askLog: Parameters<Tool.Context["ask"]>[0][] = []
        const result = yield* exec(OpenCliRunTool, { command: "pawwork-test/write-http", args: { query: "hello" } }, {
          ask: (input) =>
            Effect.sync(() => {
              askLog.push(input)
            }),
        })

        expect(askLog[0]).toMatchObject({
          permission: "opencli_write",
          patterns: ["pawwork-test/write-http"],
          always: ["pawwork-test/write-http"],
        })
        expect(result.output).toContain('"written": "hello"')
      } finally {
        getRegistry().delete("pawwork-test/write-http")
      }
    }),
  )

  it.live("aborts a non-browser adapter without waiting forever", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const controller = new AbortController()
      cli({
        site: "pawwork-test",
        name: "slow-http",
        access: "read",
        description: "Slow non-browser test adapter",
        browser: false,
        args: [],
        func: async () => {
          Effect.runFork(Deferred.succeed(started, undefined))
          return await new Promise(() => {})
        },
      })

      try {
        const fiber = yield* exec(OpenCliRunTool, { command: "pawwork-test/slow-http", args: {} }, {
          abort: controller.signal,
        }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        controller.abort()
        const exit = yield* Fiber.await(fiber)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error instanceof Error ? error.message : String(error)).toContain(
            "OpenCLI pawwork-test/slow-http was canceled",
          )
        }
      } finally {
        getRegistry().delete("pawwork-test/slow-http")
      }
    }),
  )
})
