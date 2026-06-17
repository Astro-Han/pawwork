import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import path from "path"
import { GlobTool } from "../../src/tool/glob"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import type { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"

const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const initGlob = Effect.fn("GlobToolTest.init")(function* () {
  const info = yield* GlobTool
  return yield* info.init()
})

const run = Effect.fn("GlobToolTest.run")(function* (
  args: Tool.InferParameters<typeof GlobTool>,
  next: Tool.Context = ctx,
) {
  const glob = yield* initGlob()
  return yield* glob.execute(args, next)
})

const exec = Effect.fn("GlobToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof GlobTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("GlobToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof GlobTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") throw new Error("expected glob to fail")
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error : new Error(String(error))
})

const writeFile = Effect.fn("GlobToolTest.writeFile")(function* (filePath: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(filePath, content)
})

describe("tool.glob", () => {
  it.live("lists matching files", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      yield* writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      yield* writeFile(path.join(dir, "c.txt"), "ignore\n")

      const result = yield* exec(dir, {
        pattern: "*.ts",
        path: dir,
      })

      expect(result.metadata.count).toBe(2)
      expect(result.output).toContain(path.join(dir, "a.ts"))
      expect(result.output).toContain(path.join(dir, "b.ts"))
      expect(result.output).not.toContain(path.join(dir, "c.txt"))
    }),
  )

  it.live("sorts newer files first", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const older = path.join(dir, "older.ts")
      const newer = path.join(dir, "newer.ts")
      yield* writeFile(older, "export const older = true\n")
      yield* Effect.sleep("20 millis")
      yield* writeFile(newer, "export const newer = true\n")

      const result = yield* exec(dir, {
        pattern: "*.ts",
        path: dir,
      })

      const lines = result.output.split("\n").filter(Boolean)
      expect(lines[0]).toBe(path.join(dir, "newer.ts"))
      expect(lines[1]).toBe(path.join(dir, "older.ts"))
    }),
  )

  it.live("rejects file path as search root", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "single.ts")
      yield* writeFile(file, "export const single = true\n")

      expect((yield* fail(dir, { pattern: "*.ts", path: file })).message).toContain(
        "glob path must be a directory",
      )
    }),
  )

  it.live("asks for external_directory permission when searching outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const outer = yield* tmpdirScoped()
      yield* writeFile(path.join(outer, "external.ts"), "export const ext = true\n")

      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      yield* exec(
        dir,
        {
          pattern: "*.ts",
          path: outer,
        },
        {
          ...ctx,
          ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
            Effect.sync(() => {
              requests.push(req)
            }),
        },
      )

      const ext = requests.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns[0]).toContain("*")
    }),
  )

  it.live("honors an aborted signal before starting ripgrep", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "match.ts"), "export const match = true\n")
      const controller = new AbortController()
      controller.abort()

      const error = yield* fail(
        dir,
        {
          pattern: "*.ts",
          path: dir,
        },
        {
          ...ctx,
          abort: controller.signal,
        },
      )
      expect(error.message).toMatch(/abort/i)
    }),
  )
})
