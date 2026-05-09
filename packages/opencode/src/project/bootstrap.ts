import { Bus } from "@/bus"
import { Command } from "@/command"
import { Config } from "@/config"
import { InstanceState } from "@/effect/instance-state"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Format } from "@/format"
import { LSP } from "@/lsp"
import { Plugin } from "@/plugin"
import { Project } from "@/project/project"
import { Snapshot } from "@/snapshot"
import { ShareNext } from "@/share/share-next"
import { Log } from "@opencode-ai/core/util/log"
import { Effect, Layer } from "effect"
import { InstanceBootstrap as BootstrapService } from "./bootstrap-service"
import { Vcs } from "./vcs"

const log = Log.create({ service: "instance.bootstrap" })

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  BootstrapService.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const lsp = yield* LSP.Service
    const shareNext = yield* ShareNext.Service
    const format = yield* Format.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const vcs = yield* Vcs.Service
    const snapshot = yield* Snapshot.Service

    return {
      run: Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const boot = <E, R>(init: Effect.Effect<void, E, R>) =>
          init.pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                log.error("bootstrap service failed", { cause })
              }),
            ),
          )

        yield* plugin.init()
        yield* bus.subscribeCallback(Command.Event.Executed, (payload) => {
          if (payload.properties.name === Command.Default.INIT) {
            Project.setInitialized(ctx.project.id)
          }
        }).pipe(Effect.ignore)

        yield* config.get()
        yield* Effect.forEach(
          [
            shareNext.init(),
            format.init(),
            lsp.init(),
            file.init(),
          ],
          boot,
          {
            concurrency: "unbounded",
            discard: true,
          },
        )
        yield* boot(fileWatcher.init())
        yield* boot(vcs.init())
        yield* boot(snapshot.init())
      }),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(File.defaultLayer),
  Layer.provide(FileWatcher.defaultLayer),
  Layer.provide(Format.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(Vcs.defaultLayer),
)

export const InstanceBootstrap = {
  layer,
  defaultLayer,
}
