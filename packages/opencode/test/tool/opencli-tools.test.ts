import { describe, expect } from "bun:test"
import { cli, getRegistry } from "@jackwener/opencli/registry"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer, type Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { MessageID, SessionID } from "../../src/session/schema"
import { OpenCliRunTool } from "../../src/tool/opencli-run"
import { OpenCliSearchTool } from "../../src/tool/opencli-search"
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
      const result = yield* exec(OpenCliSearchTool, { query: "12306 account", limit: 5 })

      expect(result.title).toBe('OpenCLI commands for "12306 account"')
      expect(result.output).toContain('<opencli_command name="12306/me">')
      expect(result.output).toContain("browser: true")
      expect(result.output).not.toContain("instagram/reel")
      expect(result.metadata).toMatchObject({ query: "12306 account" })
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
})

describe("opencli_run", () => {
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

      try {
        const askLog: Parameters<Tool.Context["ask"]>[0][] = []
        yield* exec(OpenCliRunTool, { command: "pawwork-test/browser-permission", args: {} }, {
          ask: (input) =>
            Effect.sync(() => {
              askLog.push(input)
            }),
        }).pipe(Effect.exit)

        expect(askLog[0]).toMatchObject({
          permission: "browser",
          patterns: ["https://auth.example.com/*", "https://example.com/*"],
        })
      } finally {
        getRegistry().delete("pawwork-test/browser-permission")
      }
    }),
  )

  it.live("runs a registered non-browser adapter through command and args", () =>
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
        expect(askLog).toEqual([])
      } finally {
        getRegistry().delete("pawwork-test/echo")
      }
    }),
  )
})
