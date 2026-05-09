import type { Argv } from "yargs"
import { Effect, Schema } from "effect"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { Instance } from "@/project/instance"
import { InstanceStore } from "@/project/instance-store"
import { cmd, type WithDoubleDash } from "./cmd/cmd"

export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
}) {}

export const fail = (message: string, exitCode = 1) => Effect.fail(new CliError({ message, exitCode }))

interface EffectCmdOpts<Args, A> {
  command: string | readonly string[]
  aliases?: string | readonly string[]
  describe: string | false
  builder?: (yargs: Argv) => Argv<Args>
  instance?: boolean | ((args: WithDoubleDash<Args>) => boolean)
  directory?: (args: WithDoubleDash<Args>) => string
  handler: (args: WithDoubleDash<Args>) => Effect.Effect<A, CliError, AppServices | InstanceStore.Service>
}

export const effectCmd = <Args, A>(opts: EffectCmdOpts<Args, A>) =>
  cmd<{}, Args>({
    command: opts.command,
    aliases: opts.aliases,
    describe: opts.describe,
    builder: opts.builder as never,
    async handler(rawArgs) {
      const args = rawArgs as unknown as WithDoubleDash<Args>
      const useInstance = typeof opts.instance === "function" ? opts.instance(args) : opts.instance !== false
      if (!useInstance) {
        await AppRuntime.runPromise(opts.handler(args))
        return
      }

      const directory = opts.directory?.(args) ?? process.cwd()
      const { store, ctx } = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) => store.load({ directory }).pipe(Effect.map((ctx) => ({ store, ctx })))),
      )

      try {
        await Instance.restore(ctx, () =>
          AppRuntime.runPromise(opts.handler(args).pipe(Effect.provideService(InstanceRef, ctx))),
        )
      } finally {
        await AppRuntime.runPromise(store.dispose(ctx))
      }
    },
  })
