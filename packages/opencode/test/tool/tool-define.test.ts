import { describe, test, expect } from "bun:test"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool"
import { ExternalResult } from "../../src/tool/external-result"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const params = Schema.Struct({ input: Schema.String })

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  test("object-defined tool does not mutate the original init object", async () => {
    const original = makeTool("test")
    const originalExecute = original.execute

    const info = await runtime.runPromise(Tool.define("test-tool", Effect.succeed(original)))

    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())

    expect(original.execute).toBe(originalExecute)
  })

  test("effect-defined tool returns fresh objects and is unaffected", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      ),
    )

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("object-defined tool returns distinct objects per init() call", async () => {
    const info = await runtime.runPromise(Tool.define("test-copy", Effect.succeed(makeTool("test"))))

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("execute receives decoded parameters", async () => {
    const parameters = Schema.Struct({
      // withDecodingDefault in Effect 4.0.0-beta.46 expects the Encoded value
      // (string for NumberFromString) — Schema.withDecodingDefaultType (decoded
      // side) only exists in newer Effect releases. Once upstream's Effect bump
      // lands we can switch to `Schema.withDecodingDefaultType(Effect.succeed(5))`.
      count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("5"))),
    })
    const calls: Array<Schema.Schema.Type<typeof parameters>> = []
    const info = await runtime.runPromise(
      Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      ),
    )
    const ctx: Tool.Context = {
      sessionID: SessionID.descending(),
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata() {
        return Effect.void
      },
      ask() {
        return Effect.void
      },
    }
    const tool = await Effect.runPromise(info.init())
    const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

    await Effect.runPromise(execute({}, ctx))
    await Effect.runPromise(execute({ count: "7" }, ctx))

    expect(calls).toEqual([{ count: 5 }, { count: 7 }])
  })

  const buildCtx = (): Tool.Context => ({
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  })

  test("wrapper lets ExternalResultError propagate as typed failure (not a defect)", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-external-result-fail",
        Effect.succeed({
          description: "raises ExternalResultError",
          parameters: params,
          execute() {
            return Effect.fail(new ExternalResult.Error({ reason: "aborted" }))
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const execute = tool.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => Effect.Effect<unknown, unknown>

    const exit = await Effect.runPromiseExit(execute({ input: "x" }, buildCtx()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const causeStr = JSON.stringify(exit.cause, null, 2)
      expect(causeStr).toContain("ExternalResultError")
      expect(causeStr).toContain("aborted")
      // The cause should NOT be a Die — typed ExternalResultError must propagate as Fail.
      expect(causeStr).not.toContain('"_tag": "Die"')
    }
  })

  test("wrapper defectifies generic typed errors (back-compat)", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-generic-fail",
        Effect.succeed({
          description: "raises generic Error",
          parameters: params,
          execute() {
            return Effect.fail(new Error("boom"))
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const execute = tool.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => Effect.Effect<unknown, unknown>

    const exit = await Effect.runPromiseExit(execute({ input: "x" }, buildCtx()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const causeStr = JSON.stringify(exit.cause, null, 2)
      // Generic errors should be defects (Die), not typed failures (Fail).
      expect(causeStr).toContain('"_tag": "Die"')
    }
  })

  test("preserves externalResult: true declaration through define/init", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-external-flag",
        Effect.succeed({
          description: "asks user",
          parameters: params,
          externalResult: true as const,
          execute() {
            return Effect.succeed({ title: "t", output: "o", metadata: { truncated: false } })
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    expect(tool.externalResult).toBe(true)
  })

  test("plain tools without externalResult retain undefined declaration", async () => {
    const info = await runtime.runPromise(Tool.define("test-no-flag", Effect.succeed(makeTool("test"))))
    const tool = await Effect.runPromise(info.init())
    expect(tool.externalResult).toBeUndefined()
  })

  test("wrapper passes through successful results", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-success",
        Effect.succeed({
          description: "succeeds",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: "done", metadata: { truncated: false } })
          },
        }),
      ),
    )
    const tool = await Effect.runPromise(info.init())
    const execute = tool.execute as unknown as (
      args: unknown,
      ctx: Tool.Context,
    ) => Effect.Effect<{ title: string; output: string; metadata: { truncated: boolean } }, unknown>

    const result = await Effect.runPromise(execute({ input: "x" }, buildCtx()))
    expect(result.title).toBe("ok")
    expect(result.output).toBe("done")
  })
})
