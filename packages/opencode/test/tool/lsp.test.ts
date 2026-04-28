import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { LspTool } from "../../src/tool/lsp"
import { Truncate } from "../../src/tool/truncate"
import type * as Tool from "../../src/tool/tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const workspaceSymbolQueries: string[] = []

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(true),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: (query) =>
      Effect.sync(() => {
        workspaceSymbolQueries.push(query)
        return []
      }),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    shutdownAll: () => Effect.void,
    invalidate: () => Effect.void,
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    lsp,
    Truncate.defaultLayer,
  ),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const run = Effect.fn("LspToolTest.run")(function* (args: Tool.InferParameters<typeof LspTool>) {
  const info = yield* LspTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.lsp", () => {
  it.live(
    "passes workspaceSymbol query to LSP",
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const file = `${dir}/test.ts`
      yield* Effect.promise(() => Bun.write(file, "export function TestSymbol() {}\n"))
      workspaceSymbolQueries.length = 0

      yield* provideInstance(dir)(
        Effect.gen(function* () {
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 1, character: 1, query: "TestSymbol" })
          yield* run({ operation: "workspaceSymbol", filePath: file, line: 1, character: 1 })
        }),
      )

      expect(workspaceSymbolQueries).toEqual(["TestSymbol", ""])
    }),
  )
})
