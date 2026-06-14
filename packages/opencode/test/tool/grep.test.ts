import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Ripgrep } from "../../src/file/ripgrep"
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

const projectRoot = path.join(__dirname, "../..")

afterEach(async () => {
  await Instance.disposeAll()
})

const initGrep = Effect.fn("GrepToolTest.init")(function* () {
  const info = yield* GrepTool
  return yield* info.init()
})

const run = Effect.fn("GrepToolTest.run")(function* (
  args: Tool.InferParameters<typeof GrepTool>,
  next: Tool.Context = ctx,
) {
  const grep = yield* initGrep()
  return yield* grep.execute(args, next)
})

const exec = Effect.fn("GrepToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof GrepTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const writeFile = Effect.fn("GrepToolTest.writeFile")(function* (filePath: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(filePath, content)
})

const symlink = Effect.fn("GrepToolTest.symlink")(function* (target: string, filePath: string) {
  yield* Effect.tryPromise(() => fs.symlink(target, filePath, "dir"))
})

const withRipgrepConfig = <A, E, R>(
  contents: string,
  self: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const config = path.join(dir, "ripgreprc")
    yield* writeFile(config, contents)

    const previous = process.env.RIPGREP_CONFIG_PATH
    process.env.RIPGREP_CONFIG_PATH = config
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH
        else process.env.RIPGREP_CONFIG_PATH = previous
      }),
    )

    return yield* self
  })

describe("tool.grep", () => {
  it.live("basic search", () =>
    Effect.gen(function* () {
      const result = yield* exec(projectRoot, {
        pattern: "export",
        path: path.join(projectRoot, "src/tool"),
        include: "*.ts",
      })
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.live("no matches returns correct output", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, {
        pattern: "xyznonexistentpatternxyz123",
        path: dir,
      })
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  it.live("handles CRLF line endings in output", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "test.txt"), "line1\nline2\nline3")

      const result = yield* exec(dir, {
        pattern: "line",
        path: dir,
      })
      expect(result.metadata.matches).toBeGreaterThan(0)
    }),
  )

  it.live("supports searching a single file path", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "match.ts"), "export const target = 'hit'\n")
      yield* writeFile(path.join(dir, "other.ts"), "export const other = 'miss'\n")

      const result = yield* exec(dir, {
        pattern: "target",
        path: path.join(dir, "match.ts"),
      })
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(path.join(dir, "match.ts"))
      expect(result.output).not.toContain(path.join(dir, "other.ts"))
    }),
  )

  it.live("throws on invalid regex instead of returning an empty result", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "match.ts"), "target\n")

      const exit = yield* exec(dir, { pattern: "[", path: dir }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("ignores RIPGREP_CONFIG_PATH from the parent environment", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFile(path.join(dir, "match.ts"), "const needle = true\n")

      yield* withRipgrepConfig(
        "--glob=!*.ts\n",
        Effect.gen(function* () {
          const result = yield* exec(dir, {
            pattern: "needle",
            path: dir,
          })

          expect(result.metadata.matches).toBe(1)
          expect(result.output).toContain(path.join(dir, "match.ts"))
        }),
      )
    }),
  )

  if (process.platform !== "win32") {
    it.live("uses the requested alias path for external_directory permission", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        yield* writeFile(path.join(outside, "match.txt"), "needle\n")
        const project = yield* tmpdirScoped({ git: true })

        const alias = path.join(project, "alias")
        yield* symlink(outside, alias)

        const ruleset = Permission.fromConfig({
          grep: "allow",
          external_directory: {
            [path.join(alias, "*")]: "allow",
          },
        })
        const asks: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const checkedCtx: Tool.Context = {
          ...ctx,
          ask: (request) =>
            Effect.sync(() => {
              asks.push(request)
              const denied = request.patterns.find(
                (pattern) => Permission.evaluate(request.permission, pattern, ruleset).action !== "allow",
              )
              if (denied) throw new Error(`unexpected permission ask: ${request.permission} ${denied}`)
            }),
        }

        const result = yield* exec(
          project,
          {
            pattern: "needle",
            path: alias,
            include: "*.txt",
          },
          checkedCtx,
        )

        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain(path.join(outside, "match.txt"))
        const externalDirectoryAsk = asks.find((request) => request.permission === "external_directory")
        expect(externalDirectoryAsk).toBeDefined()
        expect(externalDirectoryAsk!.metadata.parentDir).toBe(alias)
      }),
    )
  }
})

describe("CRLF regex handling", () => {
  test("regex correctly splits Unix line endings", () => {
    const unixOutput = "file1.txt|1|content1\nfile2.txt|2|content2\nfile3.txt|3|content3"
    const lines = unixOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("file1.txt|1|content1")
    expect(lines[2]).toBe("file3.txt|3|content3")
  })

  test("regex correctly splits Windows CRLF line endings", () => {
    const windowsOutput = "file1.txt|1|content1\r\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
    const lines = windowsOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe("file1.txt|1|content1")
    expect(lines[2]).toBe("file3.txt|3|content3")
  })

  test("regex handles mixed line endings", () => {
    const mixedOutput = "file1.txt|1|content1\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
    const lines = mixedOutput.trim().split(/\r?\n/)
    expect(lines.length).toBe(3)
  })
})
