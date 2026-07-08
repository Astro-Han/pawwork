import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool"
import { ExternalResult } from "../../src/tool/external-result"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

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
  externalResult() {
    return Effect.die(new Error("externalResult is not wired in tool-define tests"))
  },
})

describe("Tool.define", () => {
  it.live("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.live("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.live("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.live("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        // withDecodingDefault in Effect 4.0.0-beta.46 expects the Encoded value
        // (string for NumberFromString) — Schema.withDecodingDefaultType (decoded
        // side) only exists in newer Effect releases. Once upstream's Effect bump
        // lands we can switch to `Schema.withDecodingDefaultType(Effect.succeed(5))`.
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("5"))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
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
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  it.live("wrapper lets ExternalResultError propagate as typed failure (not a defect)", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-external-result-fail",
        Effect.succeed({
          description: "raises ExternalResultError",
          parameters: params,
          execute() {
            return Effect.fail(new ExternalResult.Error({ reason: "aborted" }))
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (
        args: unknown,
        ctx: Tool.Context,
      ) => Effect.Effect<unknown, unknown>

      const exit = yield* execute({ input: "x" }, buildCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause, null, 2)
        expect(causeStr).toContain("ExternalResultError")
        expect(causeStr).toContain("aborted")
        // The cause should NOT be a Die — typed ExternalResultError must propagate as Fail.
        expect(causeStr).not.toContain('"_tag": "Die"')
      }
    }),
  )

  it.live("wrapper defectifies generic typed errors (back-compat)", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-generic-fail",
        Effect.succeed({
          description: "raises generic Error",
          parameters: params,
          execute() {
            return Effect.fail(new Error("boom"))
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (
        args: unknown,
        ctx: Tool.Context,
      ) => Effect.Effect<unknown, unknown>

      const exit = yield* execute({ input: "x" }, buildCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const causeStr = JSON.stringify(exit.cause, null, 2)
        // Generic errors should be defects (Die), not typed failures (Fail).
        expect(causeStr).toContain('"_tag": "Die"')
      }
    }),
  )

  it.live("a defectified tool error rejects via runPromise as the ORIGINAL Error, not a FiberFailure", () =>
    Effect.gen(function* () {
      // The test above proves the wrapper turns Effect.fail(new Error(...)) into a Die at the
      // Effect layer. This pins the OTHER half of the path the model is actually on: the reject
      // path is Effect.runPromise (via EffectBridge run.promise), which squashes that Die back to
      // the ORIGINAL Error through causeSquash. So an expected operational mistake — e.g. tool_info
      // called with an unknown/unavailable name, both of which return Effect.fail(new Error(...)) —
      // surfaces as a clean error message, NOT a FiberFailure / messy stack that would read like an
      // alert. This is the load-bearing guarantee behind keeping those paths as plain Effect.fail.
      const info = yield* Tool.define(
        "test-defect-clean-rejection",
        Effect.succeed({
          description: "raises generic Error",
          parameters: params,
          execute() {
            return Effect.fail(new Error("clean operational message"))
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (
        args: unknown,
        ctx: Tool.Context,
      ) => Effect.Effect<unknown, unknown>

      // This assertion owns the Promise-boundary contract; setup/init still
      // runs inside the shared Effect harness.
      const rejected = yield* Effect.promise(async () => {
        try {
          await Effect.runPromise(execute({ input: "x" }, buildCtx()))
          return new Error("expected the wrapped execution to reject")
        } catch (err) {
          return err
        }
      })
      expect(rejected).toBeInstanceOf(Error)
      expect((rejected as Error).message).toBe("clean operational message")
      expect((rejected as Error).constructor.name).not.toBe("FiberFailure")
      expect(String(rejected)).not.toContain("FiberFailure")
    }),
  )

  it.live("preserves externalResult: true declaration through define/init", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-external-flag",
        Effect.succeed({
          description: "asks user",
          parameters: params,
          externalResult: true as const,
          execute() {
            return Effect.succeed({ title: "t", output: "o", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      expect(tool.externalResult).toBe(true)
    }),
  )

  it.live("plain tools without externalResult retain undefined declaration", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-no-flag", Effect.succeed(makeTool("test")))
      const tool = yield* info.init()
      expect(tool.externalResult).toBeUndefined()
    }),
  )

  it.live("wrapper passes through successful results", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-success",
        Effect.succeed({
          description: "succeeds",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: "done", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (
        args: unknown,
        ctx: Tool.Context,
      ) => Effect.Effect<{ title: string; output: string; metadata: { truncated: boolean } }, unknown>

      const result = yield* execute({ input: "x" }, buildCtx())
      expect(result.title).toBe("ok")
      expect(result.output).toBe("done")
    }),
  )
})
