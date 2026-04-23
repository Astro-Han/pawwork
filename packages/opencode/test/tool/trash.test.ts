import { afterEach, beforeEach, describe, expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "../../src/filesystem"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const trashCalls: string[][] = []

type AskRequest = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

mock.module("trash", () => ({
  default: async (paths: string[]) => {
    trashCalls.push(paths)
  },
}))

const { TrashTool } = await import("../../src/tool/trash")

const ctx = {
  sessionID: SessionID.make("ses_test-trash-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? AppFileSystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

afterEach(async () => {
  await Instance.disposeAll()
})

beforeEach(() => {
  trashCalls.length = 0
})

const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("TrashToolTest.init")(function* () {
  const info = yield* TrashTool
  return yield* info.init()
})

const run = Effect.fn("TrashToolTest.run")(function* (
  args: Tool.InferParameters<typeof TrashTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.trash", () => {
  it.live("moves project files to trash using absolute paths", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "notes.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "hello", "utf-8"))

        const requests: AskRequest[] = []
        const result = yield* run(
          { path: "notes.txt" },
          {
            ...ctx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          },
        )

        expect(result.output).toContain("Moved item to Trash")
        expect(trashCalls).toEqual([[filepath]])
        expect(requests.find((item) => item.permission === "trash")?.patterns).toEqual(["notes.txt"])
        expect(requests.find((item) => item.permission === "external_directory")).toBeUndefined()
      }),
    ),
  )

  it.live("asks for external_directory before trashing outside the project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const filepath = path.join(outer, "outside.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "outside", "utf-8"))

      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const requests: AskRequest[] = []
          yield* run(
            { path: filepath },
            {
              ...ctx,
              ask: (req) =>
                Effect.sync(() => {
                  requests.push(req)
                }),
            },
          )

          expect(trashCalls).toEqual([[filepath]])
          expect(requests.find((item) => item.permission === "external_directory")?.patterns).toEqual([
            glob(path.join(outer, "*")),
          ])
          expect(requests.find((item) => item.permission === "trash")?.patterns).toEqual([filepath])
        }),
      )
    }),
  )

  it.live("fails when the target path does not exist", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exit = yield* run({ path: path.join(dir, "missing.txt") }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(trashCalls).toEqual([])
      }),
    ),
  )

  it.live("asks for external_directory before failing on missing path outside the project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const missing = path.join(outer, "missing.txt")

      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const requests: AskRequest[] = []
          const exit = yield* run(
            { path: missing },
            {
              ...ctx,
              ask: (req) =>
                Effect.sync(() => {
                  requests.push(req)
                }),
            },
          ).pipe(Effect.exit)

          expect(exit._tag).toBe("Failure")
          expect(requests.find((item) => item.permission === "external_directory")?.patterns).toEqual([
            glob(path.join(outer, "*")),
          ])
          expect(trashCalls).toEqual([])
        }),
      )
    }),
  )
})
