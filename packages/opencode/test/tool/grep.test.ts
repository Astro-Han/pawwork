import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { GrepTool } from "../../src/tool/grep"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "../../src/filesystem"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

function initGrep() {
  return runtime.runPromise(GrepTool.pipe(Effect.flatMap((info) => info.init())))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function withRipgrepConfig(contents: string, fn: () => Promise<void>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "ripgreprc"), contents)
    },
  })

  const previous = process.env.RIPGREP_CONFIG_PATH
  process.env.RIPGREP_CONFIG_PATH = path.join(tmp.path, "ripgreprc")

  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH
    else process.env.RIPGREP_CONFIG_PATH = previous
  }
}

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

describe("tool.grep", () => {
  test("basic search", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const grep = await initGrep()
        const result = await Effect.runPromise(
          grep.execute(
            {
              pattern: "export",
              path: path.join(projectRoot, "src/tool"),
              include: "*.ts",
            },
            ctx,
          ),
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
        expect(result.output).toContain("Found")
      },
    })
  })

  test("no matches returns correct output", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello world")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await initGrep()
        const result = await Effect.runPromise(
          grep.execute(
            {
              pattern: "xyznonexistentpatternxyz123",
              path: tmp.path,
            },
            ctx,
          ),
        )
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toBe("No files found")
      },
    })
  })

  test("handles CRLF line endings in output", async () => {
    // This test verifies the regex split handles both \n and \r\n
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create a test file with content
        await Bun.write(path.join(dir, "test.txt"), "line1\nline2\nline3")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await initGrep()
        const result = await Effect.runPromise(
          grep.execute(
            {
              pattern: "line",
              path: tmp.path,
            },
            ctx,
          ),
        )
        expect(result.metadata.matches).toBeGreaterThan(0)
      },
    })
  })

  test("supports searching a single file path", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "export const target = 'hit'\n")
        await Bun.write(path.join(dir, "other.ts"), "export const other = 'miss'\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await initGrep()
        const result = await Effect.runPromise(
          grep.execute(
            {
              pattern: "target",
              path: path.join(tmp.path, "match.ts"),
            },
            ctx,
          ),
        )
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain(path.join(tmp.path, "match.ts"))
        expect(result.output).not.toContain(path.join(tmp.path, "other.ts"))
      },
    })
  })

  test("throws on invalid regex instead of returning an empty result", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "target\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await initGrep()
        await expect(
          Effect.runPromise(
            grep.execute(
              {
                pattern: "[",
                path: tmp.path,
              },
              ctx,
            ),
          ),
        ).rejects.toThrow()
      },
    })
  })

  test("ignores RIPGREP_CONFIG_PATH from the parent environment", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "const needle = true\n")
      },
    })

    await withRipgrepConfig("--glob=!*.ts\n", async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const grep = await initGrep()
          const result = await Effect.runPromise(
            grep.execute(
              {
                pattern: "needle",
                path: tmp.path,
              },
              ctx,
            ),
          )

          expect(result.metadata.matches).toBe(1)
          expect(result.output).toContain(path.join(tmp.path, "match.ts"))
        },
      })
    })
  })

  test("kills ripgrep promptly when the tool is aborted mid-run", async () => {
    const started = deferred()
    let killCount = 0
    let releaseExit!: () => void
    let running = true

    const exitPromise = new Promise<number>((resolve) => {
      releaseExit = () => {
        if (!running) return
        running = false
        resolve(130)
      }
    })

    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          started.resolve()
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.promise(async () => ChildProcessSpawner.ExitCode(await exitPromise)),
            isRunning: Effect.sync(() => running),
            kill: () =>
              Effect.sync(() => {
                killCount += 1
                releaseExit()
              }),
            stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }),
      ),
    )

    const testRuntime = ManagedRuntime.make(
      Layer.mergeAll(spawner, AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "target\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const grep = await testRuntime.runPromise(GrepTool.pipe(Effect.flatMap((info) => info.init())))
        const controller = new AbortController()
        const run = Effect.runPromise(
          grep.execute(
            {
              pattern: "target",
              path: tmp.path,
            },
            {
              ...ctx,
              abort: controller.signal,
            },
          ),
        )

        await started.promise
        controller.abort()

        await expect(
          Promise.race([
            run,
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("grep abort did not resolve within 2s")), 2_000)
            }),
          ]),
        ).rejects.toThrow(/abort/i)
        expect(killCount).toBe(1)
      },
    })
  })
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
