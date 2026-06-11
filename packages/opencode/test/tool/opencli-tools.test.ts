import { describe, expect, test } from "bun:test"
import { cli, getRegistry } from "@jackwener/opencli/registry"
import { Effect, Layer, type Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
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

function exec(tool: unknown, args: unknown, ctxOverride: Partial<Tool.Context> = {}) {
  return Instance.provide({
    directory: import.meta.dir,
    fn: () =>
      (tool as AnyToolEffect).pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((t) => t.execute(args as never, { ...ctx, ...ctxOverride } as never)),
        Effect.provide(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer)),
        Effect.runPromise,
      ),
  })
}

describe("opencli_search", () => {
  test("returns discoverable bundled adapter commands without blocked commands", async () => {
    const result = await exec(OpenCliSearchTool, { query: "12306 account", limit: 5 })

    expect(result.title).toBe('OpenCLI commands for "12306 account"')
    expect(result.output).toContain('<opencli_command name="12306/me">')
    expect(result.output).toContain("browser: true")
    expect(result.output).not.toContain("instagram/reel")
    expect(result.metadata).toMatchObject({ query: "12306 account" })
  })
})

describe("opencli_run", () => {
  test("asks for origin and domain browser permissions for pre-navigation commands", async () => {
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
      await exec(OpenCliRunTool, { command: "pawwork-test/browser-permission", args: {} }, {
        ask: (input) =>
          Effect.sync(() => {
            askLog.push(input)
          }),
      }).catch(() => undefined)

      expect(askLog[0]).toMatchObject({
        permission: "browser",
        patterns: ["https://auth.example.com/*", "https://example.com/*"],
      })
    } finally {
      getRegistry().delete("pawwork-test/browser-permission")
    }
  })

  test("runs a registered non-browser adapter through command and args", async () => {
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
      const result = await exec(OpenCliRunTool, { command: "pawwork-test/echo", args: { query: "hello" } }, {
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
  })
})
