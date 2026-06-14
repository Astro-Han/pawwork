import { Effect, Layer, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Npm } from "@opencode-ai/core/npm"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { mergeDeep } from "remeda"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Log } from "@opencode-ai/core/util/log"
import * as Formatter from "./formatter"

export namespace Format {
  const log = Log.create({ service: "format" })

  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<Status[]>
    readonly file: (filepath: string) => Effect.Effect<boolean>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Format") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* AppFileSystem.Service
      const npm = yield* Npm.Service
      const deps = { fs, npm, spawner }

      const state = yield* InstanceState.make(
        Effect.fn("Format.state")(function* (_ctx) {
          const commands: Record<string, string[] | false> = {}
          const formatters: Record<string, Formatter.Info> = {}

          const cfg = yield* config.get()
          const formatterConfig = cfg.formatter && cfg.formatter !== true ? cfg.formatter : {}

          if (cfg.formatter !== false) {
            for (const item of Object.values(Formatter)) {
              formatters[item.name] = item
            }
            for (const [name, item] of Object.entries(formatterConfig)) {
              // Ruff and uv are both the same formatter, so disabling either should disable both.
              if (["ruff", "uv"].includes(name) && (formatterConfig.ruff?.disabled || formatterConfig.uv?.disabled)) {
                // TODO combine formatters so shared backends like Ruff/uv don't need linked disable handling here.
                delete formatters.ruff
                delete formatters.uv
                continue
              }
              if (item.disabled) {
                delete formatters[name]
                continue
              }
              const info = mergeDeep(formatters[name] ?? {}, {
                extensions: [],
                ...item,
              })

              formatters[name] = {
                ...info,
                name,
                enabled: () => Effect.succeed(info.command ?? false),
              }
            }
          } else {
            log.info("all formatters are disabled")
          }

          function getCommand(item: Formatter.Info) {
            return Effect.gen(function* () {
              let cmd = commands[item.name]
              if (cmd === undefined) {
                cmd = yield* item.enabled(deps)
                commands[item.name] = cmd
              }
              return cmd
            })
          }

          function isEnabled(item: Formatter.Info) {
            return Effect.gen(function* () {
              const cmd = yield* getCommand(item)
              return cmd !== false
            })
          }

          function getFormatter(ext: string) {
            return Effect.gen(function* () {
              const matching = Object.values(formatters).filter((item) => item.extensions.includes(ext))
              const checks = yield* Effect.all(
                matching.map((item) =>
                  Effect.gen(function* () {
                    log.info("checking", { name: item.name, ext })
                    const cmd = yield* getCommand(item)
                    if (cmd) {
                      log.info("enabled", { name: item.name, ext })
                    }
                    return {
                      item,
                      cmd,
                    }
                  }),
                ),
                { concurrency: "unbounded" },
              )
              return checks
                .filter((x): x is { item: Formatter.Info; cmd: string[] } => Array.isArray(x.cmd))
                .map((x) => ({ item: x.item, cmd: x.cmd }))
            })
          }

          function formatFile(filepath: string) {
            return Effect.gen(function* () {
              log.info("formatting", { file: filepath })
              const ext = path.extname(filepath)
              const formatters = yield* getFormatter(ext)

              if (!formatters.length) return false

              let ran = false
              for (const { item, cmd } of formatters) {
                log.info("running", { command: cmd })
                const replaced = cmd.map((x) => x.replace("$FILE", filepath))
                const dir = yield* InstanceState.directory
                const code = yield* spawner
                  .spawn(
                  ChildProcess.make(replaced[0]!, replaced.slice(1), {
                    cwd: dir,
                    env: item.environment,
                    extendEnv: true,
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore",
                  }),
                  )
                  .pipe(
                    Effect.flatMap((handle) => handle.exitCode),
                    Effect.scoped,
                    Effect.catch(() =>
                      Effect.sync(() => {
                        log.error("failed to format file", {
                          error: "spawn failed",
                          command: cmd,
                          ...item.environment,
                          file: filepath,
                        })
                        return ChildProcessSpawner.ExitCode(1)
                      }),
                    ),
                  )
                if (code !== 0) {
                  log.error("failed", {
                    command: cmd,
                    ...item.environment,
                  })
                  continue
                }
                ran = true
              }
              return ran
            })
          }

          log.info("init")

          return {
            formatters,
            isEnabled,
            formatFile,
          }
        }),
      )

      const init = Effect.fn("Format.init")(function* () {
        yield* InstanceState.get(state)
      })

      const status = Effect.fn("Format.status")(function* () {
        const { formatters, isEnabled } = yield* InstanceState.get(state)
        const result: Status[] = []
        for (const formatter of Object.values(formatters)) {
          const isOn = yield* isEnabled(formatter)
          result.push({
            name: formatter.name,
            extensions: formatter.extensions,
            enabled: isOn,
          })
        }
        return result
      })

      const file = Effect.fn("Format.file")(function* (filepath: string) {
        const { formatFile } = yield* InstanceState.get(state)
        return yield* formatFile(filepath)
      })

      return Service.of({ init, status, file })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Npm.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  )
}
