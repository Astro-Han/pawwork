import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Npm } from "@opencode-ai/core/npm"
import { Config } from "../../src/config/config"
import { Format } from "../../src/format"
import * as Formatter from "../../src/format/formatter"

const it = testEffect(Layer.mergeAll(Format.defaultLayer, CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))
const itWithMockLayer = testEffect(NodeFileSystem.layer)
const encoder = new TextEncoder()

function mockSpawner(result: { code: number; stdout?: string; stderr?: string }, onCommand?: () => void) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const std = ChildProcess.isStandardCommand(command) ? command : undefined
      const output = std?.command === "air" ? result : { code: 0, stdout: "", stderr: "" }
      if (std?.command === "air") onCommand?.()
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
          stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
          stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    }),
  )
}

function formatLayerWithSpawner(spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) {
  return Layer.mergeAll(
    Format.layer.pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Npm.defaultLayer),
      Layer.provide(spawner),
    ),
    spawner,
  )
}

describe("Format", () => {
  it.live("status() returns built-in formatters when no config overrides", () =>
    provideTmpdirInstance(() =>
      Format.Service.use((fmt) =>
        Effect.gen(function* () {
          const statuses = yield* fmt.status()
          expect(Array.isArray(statuses)).toBe(true)
          expect(statuses.length).toBeGreaterThan(0)

          for (const item of statuses) {
            expect(typeof item.name).toBe("string")
            expect(Array.isArray(item.extensions)).toBe(true)
            expect(typeof item.enabled).toBe("boolean")
          }

          const gofmt = statuses.find((item) => item.name === "gofmt")
          expect(gofmt).toBeDefined()
          expect(gofmt!.extensions).toContain(".go")
        }),
      ),
    ),
  )

  it.live("status() returns empty list when formatter is disabled", () =>
    provideTmpdirInstance(
      () =>
        Format.Service.use((fmt) =>
          Effect.gen(function* () {
            expect(yield* fmt.status()).toEqual([])
          }),
        ),
      { config: { formatter: false } },
    ),
  )

  it.live("status() treats formatter=true as built-in defaults", () =>
    provideTmpdirInstance(
      () =>
        Format.Service.use((fmt) =>
          Effect.gen(function* () {
            const statuses = yield* fmt.status()
            expect(statuses.length).toBeGreaterThan(0)
            expect(statuses.find((item) => item.name === "gofmt")).toBeDefined()
          }),
        ),
      { config: { formatter: true } },
    ),
  )

  it.live("status() excludes formatters marked as disabled in config", () =>
    provideTmpdirInstance(
      () =>
        Format.Service.use((fmt) =>
          Effect.gen(function* () {
            const statuses = yield* fmt.status()
            const gofmt = statuses.find((item) => item.name === "gofmt")
            expect(gofmt).toBeUndefined()
          }),
        ),
      {
        config: {
          formatter: {
            gofmt: { disabled: true },
          },
        },
      },
    ),
  )

  it.live("status() excludes uv when ruff is disabled", () =>
    provideTmpdirInstance(
      () =>
        Format.Service.use((fmt) =>
          Effect.gen(function* () {
            const statuses = yield* fmt.status()
            expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
            expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
          }),
        ),
      {
        config: {
          formatter: {
            ruff: { disabled: true },
          },
        },
      },
    ),
  )

  it.live("status() excludes ruff when uv is disabled", () =>
    provideTmpdirInstance(
      () =>
        Format.Service.use((fmt) =>
          Effect.gen(function* () {
            const statuses = yield* fmt.status()
            expect(statuses.find((item) => item.name === "ruff")).toBeUndefined()
            expect(statuses.find((item) => item.name === "uv")).toBeUndefined()
          }),
        ),
      {
        config: {
          formatter: {
            uv: { disabled: true },
          },
        },
      },
    ),
  )

  itWithMockLayer.live("status() uses the Effect spawner for air discovery", () =>
    Effect.gen(function* () {
      let called = false
      const layer = formatLayerWithSpawner(
        mockSpawner({ code: 0, stdout: "not the R formatter\n" }, () => {
          called = true
        }),
      )

      yield* provideTmpdirInstance((dir) =>
        Effect.acquireUseRelease(
          Effect.promise(async () => {
            const bin = path.join(dir, "bin")
            const air = path.join(bin, process.platform === "win32" ? "air.cmd" : "air")
            await fs.mkdir(bin)
            await Bun.write(
              air,
              process.platform === "win32"
                ? "@echo off\r\necho Air: An R language server and formatter\r\n"
                : "#!/bin/sh\nprintf 'Air: An R language server and formatter\\n'\n",
            )
            if (process.platform !== "win32") await fs.chmod(air, 0o755)
            const oldPath = process.env.PATH
            const oldPathExt = process.env.PATHEXT
            process.env.PATH = [bin, oldPath].filter(Boolean).join(path.delimiter)
            if (process.platform === "win32") process.env.PATHEXT = [oldPathExt, ".CMD"].filter(Boolean).join(";")
            return { oldPath, oldPathExt }
          }),
          () =>
            Format.Service.use((fmt) =>
              Effect.gen(function* () {
                const air = (yield* fmt.status()).find((item) => item.name === "air")
                expect(air?.enabled).toBe(false)
                expect(called).toBe(true)
              }),
            ),
          ({ oldPath, oldPathExt }) =>
            Effect.sync(() => {
              process.env.PATH = oldPath
              if (oldPathExt === undefined) delete process.env.PATHEXT
              else process.env.PATHEXT = oldPathExt
            }),
        ),
      ).pipe(Effect.provide(layer))
    }),
  )

  it.live("service initializes without error", () => provideTmpdirInstance(() => Format.Service.use(() => Effect.void)))

  it.live("status() initializes formatter state per directory", () =>
    Effect.gen(function* () {
      const a = yield* provideTmpdirInstance(() => Format.Service.use((fmt) => fmt.status()), {
        config: { formatter: false },
      })
      const b = yield* provideTmpdirInstance(() => Format.Service.use((fmt) => fmt.status()))

      expect(a).toEqual([])
      expect(b.length).toBeGreaterThan(0)
    }),
  )

  it.live("runs enabled checks for matching formatters in parallel", () =>
    provideTmpdirInstance((path) =>
      Effect.gen(function* () {
        const file = `${path}/test.parallel`
        yield* Effect.promise(() => Bun.write(file, "x"))

        const one = {
          extensions: Formatter.gofmt.extensions,
          enabled: Formatter.gofmt.enabled,
        }
        const two = {
          extensions: Formatter.mix.extensions,
          enabled: Formatter.mix.enabled,
        }

        let active = 0
        let max = 0

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            Formatter.gofmt.extensions = [".parallel"]
            Formatter.mix.extensions = [".parallel"]
            Formatter.gofmt.enabled = () =>
              Effect.promise(async () => {
                active++
                max = Math.max(max, active)
                await Bun.sleep(20)
                active--
                return ["sh", "-c", "true"]
              })
            Formatter.mix.enabled = () =>
              Effect.promise(async () => {
                active++
                max = Math.max(max, active)
                await Bun.sleep(20)
                active--
                return ["sh", "-c", "true"]
              })
          }),
          () =>
            Format.Service.use((fmt) =>
              Effect.gen(function* () {
                yield* fmt.init()
                yield* fmt.file(file)
              }),
            ),
          () =>
            Effect.sync(() => {
              Formatter.gofmt.extensions = one.extensions
              Formatter.gofmt.enabled = one.enabled
              Formatter.mix.extensions = two.extensions
              Formatter.mix.enabled = two.enabled
            }),
        )

        expect(max).toBe(2)
      }),
    ),
  )

  it.live("runs matching formatters sequentially for the same file", () =>
    provideTmpdirInstance(
      (path) =>
        Effect.gen(function* () {
          const file = `${path}/test.seq`
          yield* Effect.promise(() => Bun.write(file, "x"))

          yield* Format.Service.use((fmt) =>
            Effect.gen(function* () {
              yield* fmt.init()
              yield* fmt.file(file)
            }),
          )

          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("xAB")
        }),
      {
        config: {
          formatter: {
            first: {
              command: ["sh", "-c", 'sleep 0.05; v=$(cat "$1"); printf \'%sA\' "$v" > "$1"', "sh", "$FILE"],
              extensions: [".seq"],
            },
            second: {
              command: ["sh", "-c", 'v=$(cat "$1"); printf \'%sB\' "$v" > "$1"', "sh", "$FILE"],
              extensions: [".seq"],
            },
          },
        },
      },
    ),
  )
})
