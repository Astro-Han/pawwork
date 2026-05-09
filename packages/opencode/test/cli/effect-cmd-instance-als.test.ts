import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { effectCmd } from "../../src/cli/effect-cmd"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

test("effectCmd preserves Instance.current for nested runPromise inside async callbacks", async () => {
  await using dir = await tmpdir()
  const command = effectCmd<{ directory: string }, void>({
    command: "probe",
    describe: false,
    directory: (args) => args.directory,
    handler: () =>
      Effect.promise(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const current = await AppRuntime.runPromise(
          Effect.sync(() => {
            try {
              return Instance.current
            } catch {
              return undefined
            }
          }),
        )
        expect(current?.directory).toBe(dir.path)
      }),
  })

  await (command.handler as any)({ directory: dir.path })
})
