import { describe, expect, test } from "bun:test"
import { Effect, Layer, type Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { OpenCliSearchTool } from "../../src/tool/opencli-search"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"

const ctx = {
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

function exec(tool: unknown, args: unknown) {
  return Instance.provide({
    directory: import.meta.dir,
    fn: () =>
      (tool as AnyToolEffect).pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((t) => t.execute(args as never, ctx as never)),
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
